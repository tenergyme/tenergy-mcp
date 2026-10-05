#!/usr/bin/env node
// Smoke test of a hosted tenergy MCP server over streamable HTTP, as a real MCP client sees it.
//   node packages/mcp/scripts/smoke-http.mjs https://mcp.tenergy.me      # after a rollout
//   node packages/mcp/scripts/smoke-http.mjs http://127.0.0.1:3333       # local `cli.js --http 3333`
// Checks: healthz; both routes initialize; anonymous sessions see only public tools (the server's
// own env keys are never lent out); get_prices answers; Nile refuses a mainnet call; a caller key
// in Authorization reaches the API (a made-up key must come back as an auth error, not as success).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] ?? 'http://127.0.0.1:3333').replace(/\/$/, '');
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const text = (result) => result.content?.map((c) => c.text ?? '').join(' ') ?? '';

async function session(path, headers = {}) {
  const client = new Client({ name: 'tenergy-mcp-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers } }));
  return client;
}

const health = await fetch(`${base}/healthz`).then((r) => r.status, () => 0);
check(health === 200, 'GET /healthz', String(health));

const PUBLIC = ['get_address_resources', 'get_prices'];
for (const path of ['/', '/nile']) {
  const client = await session(path);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(PUBLIC), `${path} anonymous tools are public only`, names.join(', '));
  const prices = await client.callTool({ name: 'get_prices', arguments: {} });
  check(!prices.isError, `${path} get_prices`, text(prices).slice(0, 120));
  if (path === '/nile') {
    const refused = await client.callTool({ name: 'get_prices', arguments: { network: 'mainnet' } });
    check(Boolean(refused.isError), '/nile refuses network=mainnet', text(refused).slice(0, 120));
  }
  await client.close();
}

const keyed = await session('/nile', { Authorization: 'ApiKey ak_test_smoke000000000000:sk_test_smoke000000000000' });
const keyedNames = (await keyed.listTools()).tools.map((t) => t.name);
check(keyedNames.includes('get_balance'), 'keyed session gets account tools', `${keyedNames.length} tools`);
const balance = await keyed.callTool({ name: 'get_balance', arguments: {} });
check(Boolean(balance.isError), 'made-up key is rejected by the API', text(balance).slice(0, 160));
await keyed.close();

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
