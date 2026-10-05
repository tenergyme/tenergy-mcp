// Spins the server up over the SDK's in-memory transport pair (the same JSON-RPC framing stdio
// carries) and calls get_prices against a stubbed fetch: no network, no API process.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FetchLike } from '@tenergy/sdk';
import { describe, expect, it } from 'vitest';
import {
  callerCredentials,
  createServer,
  hostedRequestConfig,
  keyShapedEnv,
  matchMcpRoute,
  type ServerConfig,
} from '../src/server.js';

const priceTable = {
  network: 'nile',
  as_of: '2026-09-25T10:00:00Z',
  valid_until: '2026-09-25T10:01:00Z',
  items: [
    { resource: 'energy', tier: '1h', price_sun_per_unit: 30, min_amount: 32000, max_amount: 5000000 },
    { resource: 'energy', tier: '5m', price_sun_per_unit: 20, min_amount: 32000, max_amount: 5000000 },
  ],
};

function stubFetch(status: number, body: unknown, calls: string[]): FetchLike {
  return async (url) => {
    calls.push(url);
    return {
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(body),
    };
  };
}

async function connect(fetch: FetchLike, extra: Partial<ServerConfig> = { apiKey: 'ak_test_x', apiSecret: 'sk_test_y' }) {
  const server = createServer({ apiUrl: 'https://api.test/v1', siteUrl: 'https://site.test', fetch, ...extra });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('tenergy mcp server', () => {
  it('lists the keyed and open tools and answers get_prices with the API JSON plus a human line', async () => {
    const calls: string[] = [];
    const client = await connect(stubFetch(200, priceTable, calls));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'calculate_savings', 'create_order', 'create_quote', 'estimate_contract_call', 'estimate_transfer',
      'explain_concept', 'get_address_resources', 'get_balance', 'get_chain_parameters', 'get_deposit_addresses',
      'get_energy_fee_history', 'get_market', 'get_market_summary', 'get_order', 'get_price_history', 'get_prices',
      'list_orders', 'suggest_order_size',
    ]);

    const result = await client.callTool({ name: 'get_prices', arguments: { resource: 'energy' } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual(['https://api.test/v1/prices?resource=energy']);
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.items).toEqual(priceTable.items);
    expect(out.human).toBe('2 price rows on nile; cheapest energy 20 SUN/unit (5m); valid until 2026-09-25T10:01:00Z.');
  });

  it('maps an API error envelope to slug, code and request id', async () => {
    const envelope = {
      error: { code: 1002, slug: 'invalid_parameter', message: 'resource is not valid', retryable: false },
      request_id: 'req_123',
    };
    const client = await connect(stubFetch(400, envelope, []));
    const result = await client.callTool({ name: 'get_prices', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('invalid_parameter (1002)');
    expect(text).toContain('[request_id req_123]');
  });

  it('sizes an order offline from the measured energy per transfer', async () => {
    const client = await connect(stubFetch(200, {}, []));
    const result = await client.callTool({ name: 'suggest_order_size', arguments: { to_holders: 2, to_empty: 1 } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { energy: number }).energy).toBe(2 * 64_285 + 130_285);
  });

  it('reads the market board and names the cheapest venue', async () => {
    const calls: string[] = [];
    const board = { providers: [{ slug: 'b', name: 'B', price_sun_1h: 30 }, { slug: 'a', name: 'A', price_sun_1h: 20 }] };
    const client = await connect(stubFetch(200, board, calls));
    const result = await client.callTool({ name: 'get_market', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual(['https://api.test/v1/market']);
    expect((result.content as Array<{ text: string }>).map((c) => c.text).join(' ')).toContain('A at 20 SUN');
  });

  it('offers the three flow prompts and the energy facts resource', async () => {
    const client = await connect(stubFetch(200, {}, []));
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['cheapest_energy_for_transfer', 'explain_failed_transaction', 'size_batch_order']);
    const got = await client.getPrompt({ name: 'size_batch_order', arguments: { to_holders: '3', to_empty: '1' } });
    expect(JSON.stringify(got.messages)).toContain('suggest_order_size');
    const res = await client.readResource({ uri: 'tenergy://facts/energy' });
    expect(JSON.stringify(res.contents)).toContain('64285');
  });

  const names = async (extra?: Partial<ServerConfig>) =>
    (await (await connect(stubFetch(200, {}, []), extra)).listTools()).tools.map((t) => t.name).sort();

  it('registers only the public tools without a key, and hides writes in read-only mode', async () => {
    expect(await names({})).toEqual([
      'calculate_savings', 'estimate_contract_call', 'explain_concept', 'get_address_resources', 'get_chain_parameters',
      'get_energy_fee_history', 'get_market', 'get_market_summary', 'get_price_history', 'get_prices', 'suggest_order_size',
    ]);
    const ro = await names({ apiKey: 'ak_test_x', apiSecret: 'sk_test_y', readOnly: true });
    expect(ro).not.toContain('create_order');
    expect(ro).not.toContain('create_quote');
    expect(ro).toContain('get_balance');
  });

  it('refuses create_order when the quote total exceeds the cap, and never posts the order', async () => {
    const calls: string[] = [];
    const quote = { id: 'q_1', resource: 'energy', tier: '1h', total_amount_sun: 60_000_000, created_at: 'x', expires_at: 'y' };
    const client = await connect(stubFetch(200, quote, calls), { apiKey: 'ak_test_x', apiSecret: 'sk_test_y', maxOrderTrx: 50 });
    const result = await client.callTool({
      name: 'create_order',
      arguments: { client_order_id: 'c1', max_price_sun: 70_000_000, quote_id: 'q_1' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('cap of 50 TRX');
    expect(calls).toEqual(['https://api.test/v1/quotes/q_1']);
  });

  it('offers only the tiers the API sells: 5m, 1h, 1d', async () => {
    const client = await connect(stubFetch(200, {}, []));
    const { tools } = await client.listTools();
    for (const name of ['create_quote', 'create_order', 'estimate_transfer']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as
        { properties: Record<string, { enum?: string[] }> } | undefined;
      expect(schema?.properties.tier?.enum).toEqual(['5m', '1h', '1d']);
    }
  });

  it('keeps estimate_transfer behind the key: its route needs the prices.read scope', async () => {
    expect(await names({})).not.toContain('estimate_transfer');
    expect(await names({ apiKey: 'ak_test_x', apiSecret: 'sk_test_y' })).toContain('estimate_transfer');
  });

  it('flags a 64-hex env value as a private key', () => {
    expect(keyShapedEnv({ A: 'a'.repeat(64), B: 'sk_live_abc', C: '0x' + 'F'.repeat(64) })).toEqual(['A', 'C']);
  });

  it('routes tools to mainnet vs nile based on the network argument', async () => {
    const calls: string[] = [];
    const client = await connect(stubFetch(200, priceTable, calls), {
      networks: {
        mainnet: { apiUrl: 'https://mainnet.api.test/v1' },
        nile: { apiUrl: 'https://nile.api.test/v1' },
      },
    });

    await client.callTool({ name: 'get_prices', arguments: { network: 'mainnet' } });
    await client.callTool({ name: 'get_prices', arguments: { network: 'nile' } });

    expect(calls).toEqual([
      'https://mainnet.api.test/v1/prices',
      'https://nile.api.test/v1/prices',
    ]);
  });

  it('requires confirm_mainnet: true when placing an order on mainnet', async () => {
    const client = await connect(stubFetch(200, {}, []), {
      defaultNetwork: 'mainnet',
      apiKey: 'ak_test_mainnet',
      apiSecret: 'sk_test_mainnet',
    });

    const result = await client.callTool({
      name: 'create_order',
      arguments: {
        network: 'mainnet',
        client_order_id: 'test_c1',
        max_price_sun: 1_000_000,
        quote_id: 'q_mainnet',
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('SAFETY GUARDRAIL');
  });

  it('enforces strictSandbox by forbidding any mainnet operations', async () => {
    const calls: string[] = [];
    const client = await connect(stubFetch(200, priceTable, calls), {
      strictSandbox: true,
      networks: {
        mainnet: { apiUrl: 'https://mainnet.api.test/v1' },
        nile: { apiUrl: 'https://nile.api.test/v1' },
      },
    });

    // Default call routes to nile
    const resNile = await client.callTool({ name: 'get_prices', arguments: {} });
    expect(resNile.isError).toBeFalsy();
    expect(calls).toEqual(['https://nile.api.test/v1/prices']);

    // Explicit mainnet call is blocked by sandbox
    const resMainnet = await client.callTool({ name: 'get_prices', arguments: { network: 'mainnet' } });
    expect(resMainnet.isError).toBe(true);
    expect((resMainnet.content as Array<{ text: string }>)[0]?.text).toContain('Nile sandbox endpoint');
    expect((resMainnet.content as Array<{ text: string }>)[0]?.text).toContain('Mainnet operations are strictly prohibited');
  });

  it('strictSandbox ignores mainnet credentials and only activates keyed tools when nile key is set', async () => {
    // Only mainnet key: tools should remain unkeyed
    const mainnetOnlyTools = await names({
      strictSandbox: true,
      networks: {
        mainnet: { apiKey: 'ak_main', apiSecret: 'sk_main' },
      },
    });
    expect(mainnetOnlyTools).toEqual([
      'calculate_savings', 'estimate_contract_call', 'explain_concept', 'get_address_resources', 'get_chain_parameters',
      'get_energy_fee_history', 'get_market', 'get_market_summary', 'get_price_history', 'get_prices', 'suggest_order_size',
    ]);

    // Nile key provided: keyed tools become available
    const nileKeyedTools = await names({
      strictSandbox: true,
      networks: {
        nile: { apiKey: 'ak_nile', apiSecret: 'sk_nile' },
      },
    });
    expect(nileKeyedTools).toContain('create_order');
    expect(nileKeyedTools).toContain('get_balance');
  });

  it('allows create_order on nile without confirm_mainnet flag', async () => {
    const calls: string[] = [];
    const quote = { id: 'q_nile_1', resource: 'energy', tier: '1h', total_amount_sun: 1_000_000, expires_at: '2026-10-03' };
    const order = { id: 'ord_nile_1', status: 'created', total_amount_sun: 1_000_000 };

    const fetchStub: FetchLike = async (url) => {
      calls.push(url);
      const isQuote = url.includes('/quotes');
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(isQuote ? quote : order),
      };
    };

    const client = await connect(fetchStub, {
      defaultNetwork: 'nile',
      apiKey: 'ak_test_nile',
      apiSecret: 'sk_test_nile',
    });

    const result = await client.callTool({
      name: 'create_order',
      arguments: {
        network: 'nile',
        client_order_id: 'test_nile_c1',
        max_price_sun: 2_000_000,
        quote_id: 'q_nile_1',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      'https://api.test/v1/quotes/q_nile_1',
      'https://api.test/v1/orders',
    ]);
  });

  describe('matchMcpRoute', () => {
    it('matches exact Nile paths to nile sandbox', () => {
      for (const p of ['/nile', '/nile/', '/mcp/nile', '/mcp/nile/']) {
        const res = matchMcpRoute(p);
        expect(res.matched).toBe(true);
        expect(res.network).toBe('nile');
        expect(res.strictSandbox).toBe(true);
      }
    });

    it('matches exact Mainnet paths to mainnet', () => {
      for (const p of ['/', '/mcp', '/mcp/', '/mainnet', '/mainnet/', '/mcp/mainnet', '/mcp/mainnet/']) {
        const res = matchMcpRoute(p);
        expect(res.matched).toBe(true);
        expect(res.network).toBe('mainnet');
        expect(res.strictSandbox).toBe(false);
      }
    });

    it('rejects path typos and dangerous subpaths without fallback', () => {
      for (const p of ['/nile-typo', '/mcp/niles', '/nile/extra', '/other', '/admin', '/v1/order']) {
        const res = matchMcpRoute(p);
        expect(res.matched).toBe(false);
      }
    });
  });

  describe('hosted HTTP mode', () => {
    const envConfig: ServerConfig = {
      siteUrl: 'https://site.test',
      networks: {
        mainnet: { apiUrl: 'https://api.test/v1', apiKey: 'ak_live_env', apiSecret: 'sk_live_env' },
        nile: { apiUrl: 'https://nile.test/v1', apiKey: 'ak_test_env', apiSecret: 'sk_test_env' },
      },
      apiKey: 'ak_live_env',
      apiSecret: 'sk_live_env',
    };

    it('reads the caller key only from Authorization as key:secret', () => {
      expect(callerCredentials('ApiKey ak_live_a:sk_live_b')).toEqual({ apiKey: 'ak_live_a', apiSecret: 'sk_live_b' });
      expect(callerCredentials('Bearer ak_test_a:sk_test_b')).toEqual({ apiKey: 'ak_test_a', apiSecret: 'sk_test_b' });
      for (const bad of [undefined, '', 'Bearer ak_live_a', 'ApiKey :sk', 'Basic ak:sk']) {
        expect(callerCredentials(bad)).toBeUndefined();
      }
    });

    it("never lends the process's env keys to a caller without credentials", async () => {
      const config = hostedRequestConfig(envConfig, { network: 'mainnet', strictSandbox: false });
      expect(JSON.stringify(config)).not.toMatch(/_env/);
      const server = createServer(config);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(clientSide);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('create_order');
      expect(names).not.toContain('get_balance');
      expect(names).toContain('get_prices');
    });

    it("puts the caller's key on the route's network only", () => {
      const caller = { apiKey: 'ak_test_c', apiSecret: 'sk_test_c' };
      const config = hostedRequestConfig(envConfig, { network: 'nile', strictSandbox: true }, caller);
      expect(config.networks?.nile).toEqual({ apiUrl: 'https://nile.test/v1', ...caller });
      expect(config.networks?.mainnet).toEqual({ apiUrl: 'https://api.test/v1' });
      expect(config.apiKey).toBeUndefined();
    });
  });
});
