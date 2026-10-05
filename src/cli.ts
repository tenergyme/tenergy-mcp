#!/usr/bin/env node
// `tenergy-mcp`: stdio by default, `--http <port>` for streamable HTTP (stateless, POST /mcp).
// On stdio nothing but protocol frames goes to stdout; logs go to stderr.
import { createServer as createHttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  DEFAULT_API_URL,
  DEFAULT_MAINNET_API_URL,
  DEFAULT_NILE_API_URL,
  DEFAULT_MAX_ORDER_TRX,
  VERSION,
  configFromEnv,
  callerCredentials,
  createServer,
  hostedRequestConfig,
  keyShapedEnv,
  matchMcpRoute,
} from './server.js';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`tenergy-mcp ${VERSION} - MCP server over the tenergy API (supports Mainnet & Nile testnet)

Usage: tenergy-mcp [--http <port>] [--network mainnet|nile] [--version] [--help]
  (default)      stdio transport
  --http <port>  streamable HTTP, stateless:
                   POST http://localhost:<port>/mcp       (Mainnet by default)
                   POST http://localhost:<port>/mcp/nile  (Nile testnet by default)
  --network      default network for stdio mode (mainnet | nile, default mainnet)

Environment:
  TENERGY_NETWORK            default network ("mainnet" or "nile", default mainnet)
  TENERGY_API_URL            fallback base API URL
  TENERGY_MAINNET_API_URL    Mainnet API URL (default ${DEFAULT_MAINNET_API_URL})
  TENERGY_NILE_API_URL       Nile testnet API URL (default ${DEFAULT_NILE_API_URL})
  TENERGY_MAINNET_API_KEY    Mainnet API key
  TENERGY_MAINNET_API_SECRET Mainnet HMAC secret
  TENERGY_NILE_API_KEY       Nile testnet API key
  TENERGY_NILE_API_SECRET    Nile testnet HMAC secret
  TENERGY_API_KEY            generic API key (assigned to default network)
  TENERGY_API_SECRET         generic HMAC secret (assigned to default network)
  TENERGY_SITE_URL           docs host for resources (default https://tenergy.me)
  TENERGY_MCP_READ_ONLY=1    hide create_quote and create_order
  TENERGY_MCP_MAX_ORDER_TRX  refuse create_order above this total (default ${DEFAULT_MAX_ORDER_TRX})
`);
  process.exit(0);
}
const keyVars = keyShapedEnv();
if (keyVars.length > 0) {
  console.error(
    `tenergy-mcp refuses to start: ${keyVars.join(', ')} looks like a raw private key (64 hex chars). ` +
      'This server never signs transactions and needs no wallet key; remove it from the environment.',
  );
  process.exit(1);
}

const networkIndex = args.indexOf('--network');
const cliNetwork = networkIndex !== -1 ? (args[networkIndex + 1] as 'mainnet' | 'nile') : undefined;

const httpIndex = args.indexOf('--http');
const config = configFromEnv();
if (cliNetwork === 'mainnet' || cliNetwork === 'nile') {
  config.defaultNetwork = cliNetwork;
}

if (httpIndex === -1) {
  await createServer(config).connect(new StdioServerTransport());
} else {
  const port = Number(args[httpIndex + 1] ?? process.env.HTTP_PORT ?? process.env.PORT ?? 3333);
  if (config.networks?.mainnet?.apiKey || config.networks?.nile?.apiKey) {
    console.error('tenergy-mcp: API keys in the environment are ignored over HTTP; each caller sends its own in Authorization.');
  }
  createHttpServer((req, res) => {
    const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;

    // Healthcheck endpoint for Docker / orchestration
    if (pathname === '/healthz' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OK');
      return;
    }

    // CORS headers for WebMCP and in-browser agents
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const route = matchMcpRoute(pathname, config.defaultNetwork || 'mainnet');
    if (!route.matched) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(
        JSON.stringify({
          error: 'Not Found',
          message: 'Endpoint not found. Use / for Mainnet or /nile for Nile testnet.',
        }),
      );
      return;
    }

    const reqNetwork = route.network!;
    const strictSandbox = route.strictSandbox;

    const caller = callerCredentials(req.headers['authorization']);

    // Informational GET response for browsers / human developers / simple probes without SSE header
    const acceptHeader = req.headers.accept || '';
    if (req.method === 'GET' && !acceptHeader.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(
        JSON.stringify(
          {
            name: 'tenergy-mcp',
            version: VERSION,
            description: 'Tenergy MCP Server (Model Context Protocol)',
            network: reqNetwork,
            strict_sandbox: strictSandbox,
            transport: 'streamable-http',
            authenticated: Boolean(caller),
            instructions: 'Send POST requests with MCP JSON-RPC messages to this endpoint, or connect via SSE.',
            endpoints: {
              mainnet: 'https://mcp.tenergy.me/',
              nile_sandbox: 'https://mcp.tenergy.me/nile',
            },
            docs: `${config.siteUrl}/docs/quickstart.md`,
          },
          null,
          2,
        ),
      );
      return;
    }

    const requestConfig = hostedRequestConfig(config, { network: reqNetwork, strictSandbox }, caller);

    const server = createServer(requestConfig);

    // No sessionIdGenerator: stateless mode, one server per request.
    const transport = new StreamableHTTPServerTransport({});
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport as Transport) // SDK typings predate exactOptionalPropertyTypes
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        console.error(err);
        if (!res.headersSent) res.writeHead(500).end();
      });
  }).listen(port, () => console.error(`tenergy-mcp listening on http://localhost:${port}/ (Mainnet) and /nile (Nile)`));
}
