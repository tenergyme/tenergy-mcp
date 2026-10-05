# TEnergy MCP server

Let an AI agent rent TRON energy for you: check prices, estimate a USDT transfer, place an order
and watch it land on chain — with a spending cap you set. Works with Claude, Cursor, ChatGPT and
any client that speaks the Model Context Protocol.

- **Never touches a wallet key.** It cannot sign transactions and refuses to start if one is passed.
- **Testnet by default.** Mainnet only when you point it there.
- **Capped.** An order above `TENERGY_MCP_MAX_ORDER_TRX` (default 50 TRX) is refused before buying.

## Connect

**Claude Desktop**, **Cursor** (`mcp.json`):

```json
{
  "mcpServers": {
    "tenergy": {
      "command": "npx",
      "args": ["-y", "@tenergy/mcp"],
      "env": { "TENERGY_API_KEY": "ak_test_...", "TENERGY_API_SECRET": "..." }
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add tenergy -e TENERGY_API_KEY=ak_test_... -e TENERGY_API_SECRET=... -- npx -y @tenergy/mcp
```

**ChatGPT** and other remote clients: `npx -y @tenergy/mcp --http 3333` behind HTTPS, then add
`https://<your-host>/mcp` as a connector.

No key? It still runs: `get_prices` and `get_address_resources` are public.

## Tools

| Tool | Does | Needs a key |
|---|---|---|
| `get_prices` | Energy prices per tier | no |
| `get_address_resources` | An address's energy and bandwidth right now | no |
| `estimate_transfer` | Energy a USDT transfer between two addresses needs | yes |
| `get_balance`, `get_deposit_addresses` | Your prepaid balance and where to top it up | yes |
| `create_quote` | A price held for a short time | yes |
| `create_order` | Buys energy for a receiver; requires `max_price_sun` and `client_order_id` | yes, spends |
| `get_order`, `list_orders` | Order status, delegation hashes | yes |

Resources: `tenergy://docs/quickstart`, `tenergy://llms.txt`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TENERGY_API_KEY`, `TENERGY_API_SECRET` | unset | Your key pair. Used to sign requests, never shown to the model |
| `TENERGY_API_URL` | `https://api-nile.tenergy.me/v1` | Nile testnet. Mainnet: `https://api.tenergy.me/v1` with an `ak_live_` key |
| `TENERGY_MCP_MAX_ORDER_TRX` | `50` | The most one order may cost |
| `TENERGY_MCP_READ_ONLY` | unset | `1` removes `create_quote` and `create_order`, even with a spending key |

`npx -y @tenergy/mcp --help` prints this table. Get a key in the [dashboard](https://tenergy.me/app);
test TRX for Nile from the [faucet](https://nileex.io/join/getJoinPage).

[Docs](https://tenergy.me/docs) · [TypeScript SDK](https://www.npmjs.com/package/@tenergy/sdk) · support@tenergy.me

MIT licensed. Node 22+.
