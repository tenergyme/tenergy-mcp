// Live smoke: starts dist/cli.js over stdio, lists tools, calls the public reads and prints their
// `human` lines. Usage: node scripts/smoke.mjs [apiUrl]   (default http://localhost:3001/v1)
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiUrl = process.argv[2] ?? 'http://localhost:3001/v1';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli],
  env: { PATH: process.env.PATH ?? '', TENERGY_API_URL: apiUrl },
  stderr: 'inherit',
});
const client = new Client({ name: 'tenergy-smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);
const calls = [
  ['get_prices', { resource: 'energy' }],
  ['get_address_resources', { address: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' }],
];
let failed = false;
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  failed ||= Boolean(r.isError);
  console.log(`${name}: ${r.isError ? `ERROR ${text}` : r.structuredContent?.human}`);
}
await client.close();
process.exit(failed ? 1 : 0);
