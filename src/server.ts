// The tenergy MCP server: thin tool wrappers over @tenergy/sdk plus two documentation resources.
// Tools return the API JSON unchanged plus a one-line `human` summary; API errors surface as
// `<slug> (<code>): <message> [request_id <id>]` so a host model can quote them to its user.
// Supports both Mainnet and Nile testnet in a single server process.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TenergyApiError, TenergyClient, type FetchLike } from '@tenergy/sdk';
import { z } from 'zod';
import { registerOpenPrompts, registerOpenTools } from './open-tools.js';

export const VERSION = '0.1.0-beta.0';

export type Network = 'mainnet' | 'nile';

export interface NetworkConfig {
  apiUrl?: string | undefined;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
}

export interface ServerConfig {
  defaultNetwork?: Network | undefined;
  /** When true, forbids any Mainnet calls, forcing Nile testnet exclusively. */
  strictSandbox?: boolean | undefined;
  networks?: Partial<Record<Network, NetworkConfig>> | undefined;
  /** Backward compatibility with single apiUrl / apiKey */
  apiUrl?: string | undefined;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  /** Public site that serves `/docs/quickstart.md` and `/llms.txt`. */
  siteUrl: string;
  fetch?: FetchLike | undefined;
  /** Hides create_quote and create_order. */
  readOnly?: boolean | undefined;
  /** create_order refuses a quote whose total exceeds this, in TRX. */
  maxOrderTrx?: number | undefined;
}

export const DEFAULT_MAINNET_API_URL = 'https://api.tenergy.me/v1';
export const DEFAULT_NILE_API_URL = 'https://api-nile.tenergy.me/v1';
export const DEFAULT_API_URL = DEFAULT_MAINNET_API_URL;
export const DEFAULT_MAX_ORDER_TRX = 50;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const defaultNetwork: Network = (env.TENERGY_NETWORK as Network) === 'nile' ? 'nile' : 'mainnet';
  return {
    defaultNetwork,
    networks: {
      mainnet: {
        apiUrl: env.TENERGY_MAINNET_API_URL || (defaultNetwork === 'mainnet' ? env.TENERGY_API_URL : undefined) || DEFAULT_MAINNET_API_URL,
        apiKey: env.TENERGY_MAINNET_API_KEY || (defaultNetwork === 'mainnet' ? env.TENERGY_API_KEY : undefined),
        apiSecret: env.TENERGY_MAINNET_API_SECRET || (defaultNetwork === 'mainnet' ? env.TENERGY_API_SECRET : undefined),
      },
      nile: {
        apiUrl: env.TENERGY_NILE_API_URL || (defaultNetwork === 'nile' ? env.TENERGY_API_URL : undefined) || DEFAULT_NILE_API_URL,
        apiKey: env.TENERGY_NILE_API_KEY || (defaultNetwork === 'nile' ? env.TENERGY_API_KEY : undefined),
        apiSecret: env.TENERGY_NILE_API_SECRET || (defaultNetwork === 'nile' ? env.TENERGY_API_SECRET : undefined),
      },
    },
    apiUrl: env.TENERGY_API_URL,
    apiKey: env.TENERGY_API_KEY,
    apiSecret: env.TENERGY_API_SECRET,
    siteUrl: env.TENERGY_SITE_URL || 'https://tenergy.me',
    readOnly: env.TENERGY_MCP_READ_ONLY === '1',
    maxOrderTrx: env.TENERGY_MCP_MAX_ORDER_TRX ? Number(env.TENERGY_MCP_MAX_ORDER_TRX) : DEFAULT_MAX_ORDER_TRX,
  };
}

/** Names of env vars whose value is a raw private key (64 hex chars, optional 0x). */
export function keyShapedEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(v.trim()))
    .map(([k]) => k);
}

export interface RouteMatch {
  matched: boolean;
  network?: Network;
  strictSandbox: boolean;
}

export interface CallerCredentials {
  apiKey: string;
  apiSecret: string;
}

/**
 * A hosted caller's own key from `Authorization: ApiKey <key>:<secret>` (or `Bearer <key>:<secret>`).
 * Only this header is read: Caddy redacts it in the access log, a custom secret header it would
 * write there in clear.
 */
export function callerCredentials(header: string | undefined): CallerCredentials | undefined {
  const match = /^(?:ApiKey|Bearer)\s+([^:\s]+):(\S+)$/.exec(header?.trim() ?? '');
  return match?.[1] && match[2] ? { apiKey: match[1], apiSecret: match[2] } : undefined;
}

/**
 * The config one hosted HTTP request runs with. It never carries the process's own keys: a caller
 * without credentials gets the public read-only tools, a caller with them acts for that key's
 * account on the route's network only (an `ak_test_` key is a Nile key, an `ak_live_` one mainnet).
 */
export function hostedRequestConfig(
  config: ServerConfig,
  route: { network: Network; strictSandbox: boolean },
  caller?: CallerCredentials,
): ServerConfig {
  const urls: Record<Network, NetworkConfig> = {
    mainnet: { apiUrl: config.networks?.mainnet?.apiUrl ?? DEFAULT_MAINNET_API_URL },
    nile: { apiUrl: config.networks?.nile?.apiUrl ?? DEFAULT_NILE_API_URL },
  };
  if (caller) urls[route.network] = { ...urls[route.network], ...caller };
  return {
    siteUrl: config.siteUrl,
    fetch: config.fetch,
    readOnly: config.readOnly,
    maxOrderTrx: config.maxOrderTrx,
    defaultNetwork: route.network,
    strictSandbox: route.strictSandbox,
    networks: urls,
  };
}

/** Strictly matches incoming HTTP request paths to avoid dangerous fallback routing. */
export function matchMcpRoute(pathname: string, defaultNetwork: Network = 'mainnet'): RouteMatch {
  const isNile =
    pathname === '/nile' ||
    pathname === '/nile/' ||
    pathname === '/mcp/nile' ||
    pathname === '/mcp/nile/';

  const isMainnet =
    pathname === '/' ||
    pathname === '/mcp' ||
    pathname === '/mcp/' ||
    pathname === '/mainnet' ||
    pathname === '/mainnet/' ||
    pathname === '/mcp/mainnet' ||
    pathname === '/mcp/mainnet/';

  if (isNile) {
    return { matched: true, network: 'nile', strictSandbox: true };
  }
  if (isMainnet) {
    return { matched: true, network: defaultNetwork, strictSandbox: false };
  }
  return { matched: false, strictSandbox: false };
}

const address = z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, 'base58 TRON address starting with T');
const resource = z.enum(['energy', 'bandwidth', 'activation']);
const tier = z.enum(['5m', '1h', '1d']).describe('5m, 1h (1d only when /v1/prices marks it available)');
const orderStatus = z.enum([
  'created', 'paid', 'allocating', 'delegated', 'confirmed', 'active', 'expired', 'reclaimed', 'failed', 'refunded',
]);
const networkParam = z.enum(['mainnet', 'nile']).optional().describe('Target TRON network: "mainnet" (production) or "nile" (testnet). Defaults to server default.');

type Json = Record<string, unknown>;

/** Drops undefined keys: the SDK types use exactOptionalPropertyTypes. */
function defined<T extends object>(input: T): Json {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

function ok(data: unknown, human: string): CallToolResult {
  const payload = { ...(data as Json), human };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

/** Maps an SDK error into an MCP tool error: slug, code and request id lead the message. */
export function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof TenergyApiError) {
    text = err.message; // already `<slug> (<code>): <message>`
    if (err.requestId) text += ` [request_id ${err.requestId}]`;
    if (err.retryable) text += ' (retryable)';
  } else {
    text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

const trx = (v: unknown) => (typeof v === 'number' ? `${v / 1_000_000} TRX` : 'n/a');
const listOf = (d: Json) => (Array.isArray(d.data) ? d.data : []) as unknown[];
const num = (v: unknown) => (typeof v === 'number' ? String(v) : 'n/a');

export function createServer(config: ServerConfig): McpServer {
  const isSandbox = Boolean(config.strictSandbox);
  const defaultNetwork: Network = isSandbox
    ? 'nile'
    : (config.defaultNetwork ?? (config.apiUrl?.includes('mainnet') ? 'mainnet' : 'nile'));

  // URL & credentials resolution for each network
  // In strict sandbox mode, mainnet credentials are intentionally scrubbed from memory
  const mainnetKey = isSandbox
    ? undefined
    : (config.networks?.mainnet?.apiKey ||
      (defaultNetwork === 'mainnet' && config.apiKey) ||
      config.apiKey);

  const mainnetSecret = isSandbox
    ? undefined
    : (config.networks?.mainnet?.apiSecret ||
      (defaultNetwork === 'mainnet' && config.apiSecret) ||
      config.apiSecret);

  const mainnetApiUrl =
    config.networks?.mainnet?.apiUrl ||
    (defaultNetwork === 'mainnet' && config.apiUrl) ||
    config.apiUrl ||
    DEFAULT_MAINNET_API_URL;

  const nileApiUrl =
    config.networks?.nile?.apiUrl ||
    (defaultNetwork === 'nile' && config.apiUrl) ||
    config.apiUrl ||
    DEFAULT_NILE_API_URL;

  const nileKey =
    config.networks?.nile?.apiKey ||
    (defaultNetwork === 'nile' && config.apiKey) ||
    config.apiKey;

  const nileSecret =
    config.networks?.nile?.apiSecret ||
    (defaultNetwork === 'nile' && config.apiSecret) ||
    config.apiSecret;

  const clients: Partial<Record<Network, TenergyClient>> = {
    nile: new TenergyClient({
      baseUrl: nileApiUrl,
      ...(nileKey ? { apiKey: nileKey } : {}),
      ...(nileSecret ? { apiSecret: nileSecret } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      userAgent: `tenergy-mcp/${VERSION} (nile)`,
    }),
  };

  if (!isSandbox) {
    clients.mainnet = new TenergyClient({
      baseUrl: mainnetApiUrl,
      ...(mainnetKey ? { apiKey: mainnetKey } : {}),
      ...(mainnetSecret ? { apiSecret: mainnetSecret } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
      userAgent: `tenergy-mcp/${VERSION} (mainnet)`,
    });
  }

  const resolveNet = (targetNet?: Network) => {
    const net = targetNet || defaultNetwork;
    if (isSandbox && net === 'mainnet') {
      throw new Error(
        'This MCP session is connected to the Nile sandbox endpoint (https://mcp.tenergy.me/nile). ' +
          'Mainnet operations are strictly prohibited on this connection.',
      );
    }
    const client = clients[net];
    if (!client) {
      throw new Error(`Client for network ${net} is not available in this environment.`);
    }
    const keyed = net === 'mainnet' ? Boolean(mainnetKey) : Boolean(nileKey);
    const canWrite = keyed && !config.readOnly;
    return { client, network: net, keyed, canWrite };
  };

  const server = new McpServer({ name: 'tenergy', version: VERSION });

  // In strict sandbox mode, credentials and write capabilities evaluate solely for Nile
  const hasAnyKey = isSandbox ? Boolean(nileKey) : Boolean(mainnetKey || nileKey);
  const canWriteAny = hasAnyKey && !config.readOnly;
  const capSun = Math.round((config.maxOrderTrx ?? DEFAULT_MAX_ORDER_TRX) * 1_000_000);

  const run = async (fn: () => Promise<[unknown, string]>): Promise<CallToolResult> => {
    try {
      const [data, human] = await fn();
      return ok(data, human);
    } catch (err) {
      return errorResult(err);
    }
  };

  server.registerTool('get_prices', {
    description:
      'Read-only, free, no API key needed. Returns the current rental price table: for each resource (energy, bandwidth, activation) and tier (5m, 1h, 1d) the price in SUN per unit, min/max amount and `available` (false = listed but not buyable now; do not offer it), plus when the table stops being valid. Call it before telling a user a price; these prices are indicative, a binding price comes from create_quote.',
    inputSchema: {
      network: networkParam,
      resource: resource.optional().describe('Restrict to one resource type.'),
    },
  }, ({ network: net, resource: r }) => run(async () => {
    const { client, network: targetNet } = resolveNet(net);
    const data = (await client.getPrices(r ? { resource: r } : undefined)) as Json;
    const items = (data.items ?? []) as Json[];
    const unavailable = items.filter((i) => i.available === false).map((i) => `${String(i.resource)} ${String(i.tier)}`);
    const cheapest = items
      .filter((i) => i.resource === 'energy' && i.available !== false)
      .sort((a, b) => Number(a.price_sun_per_unit) - Number(b.price_sun_per_unit))[0];
    return [data, `${items.length} price rows on ${String(data.network ?? targetNet)}` +
      (cheapest ? `; cheapest energy ${String(cheapest.price_sun_per_unit)} SUN/unit (${String(cheapest.tier)})` : '') +
      (unavailable.length > 0 ? `; not available to buy now: ${unavailable.join(', ')}` : '') +
      `; valid until ${String(data.valid_until)}.`];
  }));

  if (hasAnyKey) {
    server.registerTool('estimate_transfer', {
      description:
        'Read-only, free, needs TENERGY_API_KEY with the prices.read permission. Estimates how much energy and bandwidth a token transfer between two addresses will consume (USDT by default, or another TRC-20 contract) and what it costs burned versus rented. Use it to size an order before create_quote; it spends nothing.',
      inputSchema: {
        network: networkParam,
        from_address: address.describe('Sender, base58 T...'),
        to_address: address.describe('Recipient, base58 T...'),
        contract_address: address.optional().describe('TRC-20 contract; USDT when omitted.'),
        amount: z.string().optional().describe('Token amount as a decimal string.'),
        tier: tier.optional(),
      },
    }, ({ network: net, ...args }) => run(async () => {
      const { client, keyed, network: targetNet } = resolveNet(net);
      if (!keyed) throw new Error(`Network ${targetNet} has no API key configured.`);
      const data = (await client.estimateTransferEnergy(
        defined(args) as Parameters<TenergyClient['estimateTransferEnergy']>[0],
      )) as Json;
      return [data, `[${targetNet}] Transfer needs ${num(data.energy_required)} energy (order ${num(data.recommended_amount)}); rented ${trx(data.total_amount_sun)} vs burned ${trx(data.burn_alternative_sun)}.`];
    }));
  }

  server.registerTool('get_address_resources', {
    description:
      'Read-only, free, no API key needed. Returns the on-chain energy and bandwidth an address has right now (limits, used, available) and whether it is activated. Call it before buying to see whether the address already has enough energy for its next transfer.',
    inputSchema: {
      network: networkParam,
      address: address.describe('TRON address, base58 T...'),
    },
  }, ({ network: net, address: a }) => run(async () => {
    const { client, network: targetNet } = resolveNet(net);
    const data = (await client.getAddressResources(a)) as Json;
    const e = (data.energy ?? {}) as Json;
    const b = (data.bandwidth ?? {}) as Json;
    return [data, `[${targetNet}] ${a}: ${num(e.available)} energy, ${num(b.available)} bandwidth available${data.activated === false ? ', not activated' : ''}.`];
  }));

  if (hasAnyKey) {
    server.registerTool('get_balance', {
      description:
        'Read-only, free, needs TENERGY_API_KEY. Returns the prepaid account balance that orders are paid from, available and pending. Check it before create_order: an order larger than the balance is refused.',
      inputSchema: {
        network: networkParam,
      },
    }, ({ network: net }) => run(async () => {
      const { client, keyed, network: targetNet } = resolveNet(net);
      if (!keyed) throw new Error(`Network ${targetNet} has no API key configured.`);
      const data = (await client.getBalance()) as Json;
      return [data, `[${targetNet}] Balance available: ${trx(data.available_sun)} of ${trx(data.balance_sun)}.`];
    }));
  }

  if (hasAnyKey) {
    server.registerTool('get_deposit_addresses', {
      description:
        "Read-only, free, needs TENERGY_API_KEY. Returns the account's own deposit addresses: TRX or USDT sent there is credited to the prepaid balance. Give the address to the user to top up; never send funds yourself.",
      inputSchema: {
        network: networkParam,
      },
    }, ({ network: net }) => run(async () => {
      const { client, keyed, network: targetNet } = resolveNet(net);
      if (!keyed) throw new Error(`Network ${targetNet} has no API key configured.`);
      const data = (await client.listDepositAddresses()) as Json;
      const rows = listOf(data) as Json[];
      return [data, rows.length ? `[${targetNet}] ` + rows.map((r) => `${String(r.currency)} ${String(r.address)}`).join('; ') : 'No deposit address.'];
    }));
  }

  if (canWriteAny) {
    server.registerTool('create_quote', {
      description:
        'Spends nothing, needs TENERGY_API_KEY. Creates a binding price quote for renting an amount of a resource for a tier, valid until expires_at. Show total_amount_sun to the user, then pass the quote id to create_order as quote_id to lock that price.',
      inputSchema: {
        network: networkParam,
        resource,
        tier,
        amount: z.number().int().positive().optional().describe('Units of energy or bandwidth; omit for activation.'),
        receiver: address.optional().describe('Address that will receive the delegation.'),
        idempotency_key: z.string().max(128).optional(),
      },
    }, ({ network: net, idempotency_key, ...body }) => run(async () => {
      const { client, canWrite, network: targetNet } = resolveNet(net);
      if (!canWrite) throw new Error(`Network ${targetNet} has no write-scoped API key configured.`);
      const data = (await client.createQuote(
        defined(body) as Parameters<TenergyClient['createQuote']>[0],
        idempotency_key ? { idempotencyKey: idempotency_key } : {},
      )) as Json;
      return [data, `[${targetNet}] Quote ${String(data.id)}: ${trx(data.total_amount_sun)} for ${typeof data.amount === 'number' ? `${data.amount} ` : ''}${String(data.resource)} ${String(data.tier)}, expires ${String(data.expires_at)}.`];
    }));
  }

  if (canWriteAny) {
    server.registerTool('create_order', {
      description:
        'SPENDS MONEY from the prepaid balance; needs TENERGY_API_KEY with the orders.create permission. Rents energy or bandwidth (or activates) for a receiver address. When ordering on Mainnet, confirm_mainnet MUST be explicitly set to true. The server refuses any order whose total exceeds its TENERGY_MCP_MAX_ORDER_TRX cap (default 50 TRX).',
      inputSchema: {
        network: networkParam,
        confirm_mainnet: z.boolean().optional().describe('SAFETY GUARD: Must be true when executing on Mainnet to confirm real TRX spending with the user.'),
        client_order_id: z.string().min(1).max(128).describe('Your idempotency id; reuse it on retry.'),
        max_price_sun: z.number().int().positive().describe('Refuse if the total would exceed this, in SUN.'),
        quote_id: z.string().optional(),
        resource: resource.optional(),
        tier: tier.optional(),
        amount: z.number().int().positive().optional(),
        receiver: address.optional(),
        activate: z.boolean().optional(),
      },
    }, ({ network: net, confirm_mainnet, ...args }) => run(async () => {
      const { client, canWrite, network: targetNet } = resolveNet(net);
      if (!canWrite) throw new Error(`Network ${targetNet} has no write-scoped API key configured.`);

      // Guardrail against accidental Mainnet spend
      if (targetNet === 'mainnet' && confirm_mainnet !== true) {
        throw new Error(
          'SAFETY GUARDRAIL: You are attempting to place a REAL MONEY order on MAINNET. ' +
          'You MUST ask the user for confirmation first, and then call this tool with confirm_mainnet: true.'
        );
      }

      // Spend cap: price the order before it is placed and refuse above TENERGY_MCP_MAX_ORDER_TRX.
      const quote = (args.quote_id
        ? await client.getQuote(args.quote_id)
        : await client.createQuote(defined({
          resource: args.resource, tier: args.tier, amount: args.amount, receiver: args.receiver,
        }) as Parameters<TenergyClient['createQuote']>[0])) as Json;
      const total = Number(quote.total_amount_sun);
      if (!Number.isFinite(total) || total > capSun) {
        throw new Error(`order total ${trx(quote.total_amount_sun)} exceeds this server's cap of ${capSun / 1_000_000} TRX ` +
          '(TENERGY_MCP_MAX_ORDER_TRX); nothing was bought. Ask the user to raise the cap or order less.');
      }
      const data = (await client.createOrder(
        defined(args) as Parameters<TenergyClient['createOrder']>[0],
        { idempotencyKey: args.client_order_id },
      )) as Json;
      return [data, `[${targetNet}] Order ${String(data.id)} is ${String(data.status)}, price ${trx(data.total_amount_sun)}.`];
    }));
  }

  if (hasAnyKey) {
    server.registerTool('get_order', {
      description:
        'Read-only, free, needs TENERGY_API_KEY. Returns one order with its status (created, paid, allocating, delegated, confirmed, active, expired, reclaimed, failed, refunded), delivered amount and chain transactions. Pass our order id, or cid:<client_order_id> after a lost response.',
      inputSchema: {
        network: networkParam,
        order_id: z.string().min(1).describe('Order id, or cid:<client_order_id>.'),
      },
    }, ({ network: net, order_id }) => run(async () => {
      const { client, keyed, network: targetNet } = resolveNet(net);
      if (!keyed) throw new Error(`Network ${targetNet} has no API key configured.`);
      const data = (await client.getOrder(order_id)) as Json;
      return [data, `[${targetNet}] Order ${String(data.id)}: ${String(data.status)}.`];
    }));
  }

  if (hasAnyKey) {
    server.registerTool('list_orders', {
      description:
        "Read-only, free, needs TENERGY_API_KEY. Lists the account's orders newest first, filterable by status, receiver or client_order_id, paginated by an opaque cursor (pass next_cursor back as cursor).",
      inputSchema: {
        network: networkParam,
        status: z.array(orderStatus).optional(),
        receiver: address.optional(),
        client_order_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    }, ({ network: net, ...args }) => run(async () => {
      const { client, keyed, network: targetNet } = resolveNet(net);
      if (!keyed) throw new Error(`Network ${targetNet} has no API key configured.`);
      const data = (await client.listOrders(defined(args) as Parameters<TenergyClient['listOrders']>[0])) as Json;
      return [data, `[${targetNet}] ${listOf(data).length} order(s)${data.next_cursor ? ', more available' : ''}.`];
    }));
  }

  // Open tools (no key, no spend): market, history, chain parameters, contract simulation, savings.
  registerOpenTools(server, {
    apiUrl: (n) => (n === 'nile' ? nileApiUrl : mainnetApiUrl).replace(/\/$/, ''),
    nodeUrl: (n) => (n === 'nile' ? 'https://nile.trongrid.io' : 'https://api.trongrid.io'),
    fetch: config.fetch ?? (globalThis.fetch as unknown as FetchLike),
    defaultNetwork: isSandbox ? 'nile' : defaultNetwork,
    run,
    networkParam,
  });

  registerOpenPrompts(server);

  const fetchDoc = async (path: string): Promise<string> => {
    const f = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const res = await f(new URL(path, config.siteUrl).toString(), {
      method: 'GET',
      headers: { accept: 'text/markdown, text/plain' },
    });
    if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status}`);
    return res.text();
  };

  server.registerResource('quickstart', 'tenergy://docs/quickstart', {
    title: 'Agent quickstart',
    description: 'How an agent prices, quotes and orders energy.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await fetchDoc('/docs/quickstart.md') }],
  }));

  server.registerResource('llms-txt', 'tenergy://llms.txt', {
    title: 'llms.txt',
    description: 'Index of the agent-facing documentation.',
    mimeType: 'text/plain',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: await fetchDoc('/llms.txt') }],
  }));

  return server;
}
