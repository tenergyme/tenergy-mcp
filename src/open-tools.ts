// Open tools: read-only, free, no API key. They answer what an agent wants to know before it spends
// anything. Nothing here needs a private key or spends money; the static figures carry the date
// they were measured.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '@tenergy/sdk';
import { z } from 'zod';

type Json = Record<string, unknown>;
type Network = 'mainnet' | 'nile';

export interface OpenToolDeps {
  /** our API base per network, e.g. https://api.tenergy.me/v1 */
  apiUrl: (net: Network) => string;
  /** a public TRON node per network, for chain reads */
  nodeUrl: (net: Network) => string;
  fetch: FetchLike;
  defaultNetwork: Network;
  run: (fn: () => Promise<[unknown, string]>) => Promise<CallToolResult>;
  networkParam: z.ZodTypeAny;
}

/** Measured on mainnet transfers, 2026-09-30 (site facts `usdt-energy-holder` / `usdt-energy-empty`). */
export const USDT_ENERGY = { holder: 64_285, empty: 130_285 } as const;
/** getEnergyFee history from TronGrid listproposals, read 2026-10-04. */
export const ENERGY_FEE_HISTORY = [
  { proposal: 4, sun: 20, from: '2018-11-19' },
  { proposal: 9, sun: 10, from: '2018-12-13' },
  { proposal: 47, sun: 40, from: '2020-11-24' },
  { proposal: 51, sun: 140, from: '2021-02-11' },
  { proposal: 71, sun: 280, from: '2021-10-28' },
  { proposal: 79, sun: 420, from: '2022-12-04' },
  { proposal: 95, sun: 210, from: '2024-09-19' },
  { proposal: 104, sun: 100, from: '2025-08-29' },
] as const;

const CONCEPTS: Record<string, string> = {
  energy: 'Energy pays for smart contract execution on TRON (a USDT transfer is a contract call). Without energy the network burns TRX at getEnergyFee SUN per unit. Energy comes from staking TRX or from a delegation by someone who staked.',
  bandwidth: 'Bandwidth pays for the bytes of a transaction. Every activated account gets 600 free bandwidth a day; a USDT transfer uses about 345, so the first one a day is usually free; after that it burns about 0.35 TRX.',
  delegation: 'Stake 2.0 lets a staker delegate the energy of its stake to another address (DelegateResourceContract). The receiver spends it; nothing leaves the receiver\'s wallet and no key is shared. The staker can reclaim it after the lock period.',
  burn: 'When an address lacks energy, the network burns TRX from it instead: energy needed × getEnergyFee SUN (100 SUN since proposal #104, 2025-08-29).',
  activation: 'A new TRON address must be activated before it can be used; the first TRX transfer to it activates it. Sending USDT to an address with a zero USDT balance needs about twice the energy (130,285 vs 64,285).',
  recovery: 'Used energy of a staked address recovers linearly over 24 hours. Delegated (rented) energy is used once and reclaimed by the lender at the end of the term.',
  rental: 'Renting energy = a provider delegates energy to your address for a term (e.g. 1 hour) for a price in SUN per unit, usually a fraction of the burn price. Order the amount the transfer needs, then send within the term.',
  routing: 'TEnergy routes each order to the cheapest venue that can fill it at that moment and to the next one if a provider fails; delivery is verified on chain before the order is settled.',
};

async function getJson(f: FetchLike, url: string, init?: { method?: string; body?: string }): Promise<Json> {
  const res = await f(url, {
    method: init?.method ?? 'GET',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...(init?.body ? { body: init.body } : {}),
  });
  if (res.status !== 200) throw new Error(`${init?.method ?? 'GET'} ${url} answered ${res.status}`);
  return JSON.parse(await res.text()) as Json;
}

export function registerOpenTools(server: McpServer, d: OpenToolDeps): void {
  const net = (n?: Network) => n ?? d.defaultNetwork;

  server.registerTool('get_market', {
    description: 'Read-only, free, no API key. The live energy market: every venue TEnergy reads with its 1-hour and 1-day price per unit (SUN), when it was read, and our own price. Use it to compare venues or to tell a user where energy is cheapest right now.',
    inputSchema: { network: d.networkParam },
  }, ({ network }) => d.run(async () => {
    const data = await getJson(d.fetch, `${d.apiUrl(net(network))}/market`);
    const rows = (Array.isArray(data.providers) ? data.providers : []) as Json[];
    const priced = rows.filter((r) => typeof r.price_sun_1h === 'number').sort((a, b) => Number(a.price_sun_1h) - Number(b.price_sun_1h));
    const best = priced[0];
    return [data, `${rows.length} venues read` + (best ? `; cheapest 1 h: ${String(best.name ?? best.slug)} at ${String(best.price_sun_1h)} SUN/unit` : '') + '.'];
  }));

  server.registerTool('get_price_history', {
    description: 'Read-only, free, no API key. Price history of one market venue (slug from get_market; "tenergy" for ours): 5-minute points of the 1-hour and 1-day price over the last N hours.',
    inputSchema: {
      network: d.networkParam,
      slug: z.string().min(1).describe('Venue slug from get_market, e.g. "netts", or "tenergy".'),
      hours: z.number().int().min(1).max(720).optional().describe('How far back, hours (default 24).'),
    },
  }, ({ network, slug, hours }) => d.run(async () => {
    const data = await getJson(d.fetch, `${d.apiUrl(net(network))}/market/history?slug=${encodeURIComponent(slug)}&hours=${hours ?? 24}`);
    const points = (Array.isArray(data.points) ? data.points : []) as Json[];
    const prices = points.map((p) => p.price_sun_1h).filter((v): v is number => typeof v === 'number');
    return [data, `${slug}: ${points.length} points` + (prices.length ? `, 1 h price ${Math.min(...prices)}–${Math.max(...prices)} SUN` : '') + '.'];
  }));

  server.registerTool('get_market_summary', {
    description: 'Read-only, free, no API key. One month of the energy market: for each venue min / median / max price, number of readings and share of time it answered, plus the median price by hour of day (UTC). Month as YYYY-MM.',
    inputSchema: {
      network: d.networkParam,
      month: z.string().regex(/^\d{4}-\d{2}$/).describe('YYYY-MM, the current month or earlier.'),
    },
  }, ({ network, month }) => d.run(async () => {
    const data = await getJson(d.fetch, `${d.apiUrl(net(network))}/market/summary?month=${month}`);
    const rows = (Array.isArray(data.providers) ? data.providers : []) as Json[];
    return [data, `${month}: ${rows.length} venues summarised.`];
  }));

  server.registerTool('get_chain_parameters', {
    description: 'Read-only, free, no API key. The TRON fee parameters now, read from a public node: energy price (getEnergyFee, SUN per unit), bandwidth price (getTransactionFee), free bandwidth per day, unstake delay in days.',
    inputSchema: { network: d.networkParam },
  }, ({ network }) => d.run(async () => {
    const raw = await getJson(d.fetch, `${d.nodeUrl(net(network))}/wallet/getchainparameters`);
    const list = (Array.isArray(raw.chainParameter) ? raw.chainParameter : []) as Json[];
    const pick = (k: string) => list.find((p) => p.key === k)?.value as number | undefined;
    const data = {
      energy_fee_sun: pick('getEnergyFee') ?? null,
      transaction_fee_sun_per_byte: pick('getTransactionFee') ?? null,
      free_bandwidth_per_day: pick('getFreeNetLimit') ?? null,
      unfreeze_delay_days: pick('getUnfreezeDelayDays') ?? null,
    };
    return [data, `Energy ${String(data.energy_fee_sun)} SUN/unit, bandwidth ${String(data.transaction_fee_sun_per_byte)} SUN/byte, ${String(data.free_bandwidth_per_day)} free bandwidth a day.`];
  }));

  server.registerTool('estimate_contract_call', {
    description: 'Read-only, free, no API key, nothing signed. Simulates a smart contract call on a public node (triggerconstantcontract) and returns the energy it would use and the TRX it would burn without energy. Give the function selector, e.g. "transfer(address,uint256)", and the ABI-encoded parameter hex.',
    inputSchema: {
      network: d.networkParam,
      owner_address: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/).describe('Caller, base58'),
      contract_address: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/).describe('Contract, base58'),
      function_selector: z.string().min(3),
      parameter: z.string().regex(/^[0-9a-fA-F]*$/).describe('ABI-encoded arguments, hex without 0x'),
    },
  }, ({ network, ...call }) => d.run(async () => {
    const n = net(network);
    const sim = await getJson(d.fetch, `${d.nodeUrl(n)}/wallet/triggerconstantcontract`, {
      method: 'POST',
      body: JSON.stringify({ ...call, visible: true }),
    });
    const params = await getJson(d.fetch, `${d.nodeUrl(n)}/wallet/getchainparameters`);
    const fee = ((params.chainParameter as Json[] | undefined) ?? []).find((p) => p.key === 'getEnergyFee')?.value as number | undefined;
    const energy = typeof sim.energy_used === 'number' ? sim.energy_used : null;
    const result = (sim.result ?? {}) as Json;
    const data = { energy_used: energy, energy_fee_sun: fee ?? null, burn_sun: energy !== null && fee ? energy * fee : null, ok: result.result === true, message: result.message ?? null };
    return [data, energy === null ? 'The node returned no energy figure; check the parameters.' : `Would use ${energy} energy; without energy it burns ${data.burn_sun !== null ? data.burn_sun / 1_000_000 : 'n/a'} TRX.`];
  }));

  server.registerTool('suggest_order_size', {
    description: 'Free, offline. How much energy to order for N USDT transfers, given how many go to addresses that already hold USDT and how many to addresses with a zero USDT balance (measured 2026-09-30: 64,285 vs 130,285 energy per transfer). Use get_address_resources first to know which case a recipient is.',
    inputSchema: {
      to_holders: z.number().int().min(0).describe('Transfers to addresses that hold USDT'),
      to_empty: z.number().int().min(0).describe('Transfers to addresses with zero USDT'),
    },
  }, ({ to_holders, to_empty }) => d.run(async () => {
    const energy = to_holders * USDT_ENERGY.holder + to_empty * USDT_ENERGY.empty;
    const data = { energy, per_transfer: USDT_ENERGY, measured: '2026-09-30' };
    return [data, `Order at least ${energy.toLocaleString('en-US')} energy for ${to_holders + to_empty} transfer(s).`];
  }));

  server.registerTool('calculate_savings', {
    description: 'Free. What renting energy saves versus burning TRX for USDT transfers: uses the live energy price from our price table and the chain burn price. Give transfers per day and the share that go to empty addresses.',
    inputSchema: {
      network: d.networkParam,
      transfers_per_day: z.number().int().min(1),
      share_to_empty: z.number().min(0).max(1).optional().describe('0..1, default 0'),
    },
  }, ({ network, transfers_per_day, share_to_empty }) => d.run(async () => {
    const n = net(network);
    const table = await getJson(d.fetch, `${d.apiUrl(n)}/prices?resource=energy`);
    const items = (Array.isArray(table.items) ? table.items : []) as Json[];
    const rent = items.filter((i) => i.available !== false && typeof i.price_sun_per_unit === 'number').map((i) => Number(i.price_sun_per_unit)).sort((a, b) => a - b)[0];
    const params = await getJson(d.fetch, `${d.nodeUrl(n)}/wallet/getchainparameters`);
    const burn = ((params.chainParameter as Json[] | undefined) ?? []).find((p) => p.key === 'getEnergyFee')?.value as number | undefined;
    if (rent === undefined || burn === undefined) throw new Error('No live energy price or burn price available right now.');
    const e = share_to_empty ?? 0;
    const perTransfer = USDT_ENERGY.holder * (1 - e) + USDT_ENERGY.empty * e;
    const day = transfers_per_day * perTransfer;
    const data = { rent_sun_per_unit: rent, burn_sun_per_unit: burn, energy_per_day: Math.round(day), burn_trx_per_day: (day * burn) / 1e6, rent_trx_per_day: (day * rent) / 1e6, saving_share: 1 - rent / burn };
    return [data, `Per day: burn ${data.burn_trx_per_day.toFixed(2)} TRX vs rent ${data.rent_trx_per_day.toFixed(2)} TRX (saves ${Math.round(data.saving_share * 100)} % on energy; bandwidth not included).`];
  }));

  server.registerTool('get_energy_fee_history', {
    description: 'Free, offline. Every approved change of the TRON energy price (getEnergyFee) since 2018 with its committee proposal and date, read from the chain on 2026-10-04.',
    inputSchema: {},
  }, () => d.run(async () => [{ history: ENERGY_FEE_HISTORY, read: '2026-10-04' }, `Now ${ENERGY_FEE_HISTORY.at(-1)!.sun} SUN since ${ENERGY_FEE_HISTORY.at(-1)!.from} (proposal #${ENERGY_FEE_HISTORY.at(-1)!.proposal}); peak 420 SUN from 2022-12-04.`]));

  server.registerTool('explain_concept', {
    description: `Free, offline. A short, accurate explanation of a TRON resource concept for a user. Concepts: ${Object.keys(CONCEPTS).join(', ')}.`,
    inputSchema: { concept: z.enum(Object.keys(CONCEPTS) as [string, ...string[]]) },
  }, ({ concept }) => d.run(async () => [{ concept, text: CONCEPTS[concept] }, CONCEPTS[concept]!]));
}

/** Prompt arguments arrive as strings (MCP prompts), so every argument is a string schema. */
const text = (description: string) => z.string().describe(description);

/**
 * Prompts and static resources (E15, 2026-10-04): MERX ships 30 prompts and 21 resources; these are the flows our
 * users actually ask for, each pointing the agent at the open tools above. No prompt spends money.
 */
export function registerOpenPrompts(server: McpServer): void {
  server.registerPrompt('cheapest_energy_for_transfer', {
    title: 'Cheapest energy for one USDT transfer',
    description: 'Size the energy for a transfer from the recipient, compare venues, and show burn vs rent.',
    argsSchema: { recipient: text('Recipient TRON address (base58 T…)') },
  }, ({ recipient }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `I want to send USDT TRC-20 to ${recipient} as cheaply as possible. 1) Ask me whether ${recipient} already holds USDT (an address with a zero USDT balance needs about twice the energy); then call suggest_order_size with to_holders=1 or to_empty=1, and get_address_resources to see the sender's free energy if I give you the sender. 2) Call get_market and name the cheapest venue for 1 hour. 3) Call calculate_savings with transfers_per_day=1. Summarise: energy to order, cheapest price now, TRX burned without energy vs paid with rental. Do not place an order.` },
    }],
  }));

  server.registerPrompt('size_batch_order', {
    title: 'Size an energy order for a batch of transfers',
    description: 'How much energy a batch of USDT payouts needs and what it saves per day.',
    argsSchema: {
      to_holders: text('Transfers to addresses that already hold USDT'),
      to_empty: text('Transfers to addresses with a zero USDT balance'),
    },
  }, ({ to_holders, to_empty }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Plan energy for a payout batch: ${to_holders} transfers to USDT holders and ${to_empty} to empty addresses. Call suggest_order_size with those numbers, then calculate_savings with transfers_per_day = their sum and share_to_empty = the empty share. Report the energy to order and the daily saving. Do not place an order.` },
    }],
  }));

  server.registerPrompt('explain_failed_transaction', {
    title: 'Explain a failed TRON transaction',
    description: 'Read a transaction by id and explain why it failed and what to do.',
    argsSchema: { txid: text('Transaction id (64 hex characters)') },
  }, ({ txid }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `My TRON transaction ${txid} did not go through. Explain in plain words what happened and what to do next. Point me to https://tenergy.me/tools/failed-transaction (paste the id there) as the reference for result codes (OUT_OF_ENERGY, REVERT, OUT_OF_TIME, BANDWITH_ERROR …) and explain_concept for energy and bandwidth. If energy was the cause, use calculate_savings to show what renting would have cost.` },
    }],
  }));

  server.registerResource('energy-facts', 'tenergy://facts/energy', {
    title: 'TRON energy facts',
    description: 'Measured energy per USDT transfer and the energy fee history, with dates.',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({ usdt_transfer_energy: USDT_ENERGY, measured: '2026-09-30', energy_fee_history: ENERGY_FEE_HISTORY, history_read: '2026-10-04' }, null, 2),
    }],
  }));
}
