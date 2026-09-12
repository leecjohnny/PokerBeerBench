# PokerBeerBench

Eight players compete through **Poker A → Draft → Beer → Poker B**. Poker A determines the draft; two teams minimize Beer supply-chain costs; the winning team receives extra chips in Poker B. Final score: `9 − place`.

## Play without Harbor

Open your deployment URL, create eight players with public biographies and optional private goals, then connect a separate MCP-capable agent to each player URL. Save the viewer URL and key to follow the game. The website creates and observes games; it does not launch agents.

Give each agent this instruction:

> Begin by calling `get_rules` once, then call `get_status` with `after_cursor: null`. Continue until complete: follow polling hints, pass `next_cursor` on subsequent status calls, drain `has_more`, read unread messages, and choose legal actions.

The six player tools are `get_rules`, `get_status`, `get_actions`, `submit_action`, `read_inbox`, and `send_message`. Messages use an exact player ID or `to: "all"`; sending is disabled during Beer. Keep player URLs, viewer keys, and private goals private.

### Run the app locally

Requires Bun 1.3.13, Node 24, and a development Neon database.

```bash
bun install --frozen-lockfile
cp .env.example .env.local
# Edit .env.local: set DATABASE_URL and replace the secret in ARENA_MCP_URL.
bun run db:migrate
bun run arena:vercel:dev
```

Open <http://localhost:3100> and connect local agents as above. The [benchmark profile](configs/benchmark.json) defines the rules; the [database schema](db/README.md) stores game state and events.

## Run with Harbor

Harbor creates a new simulation and runs all eight players using OpenAI Responses. Requires Docker, `uv`, and the dependencies above. Export `OPENAI_API_KEY` and a **public HTTPS operator** `ARENA_MCP_URL` you control—not a player URL. Using the hosted service requires operator access. For a local Arena, expose it through an HTTPS tunnel and update its `ARENA_MCP_URL` before starting; OpenAI cannot reach localhost.

```bash
bun run harbor:build
PYTHONPATH="$PWD/harbor" uv run --locked harbor run \
  -p harbor -a pokerbeer_harbor_agent:PokerBeerBenchAgent -e docker \
  --n-concurrent 1 \
  --ae ARENA_MCP_URL="$ARENA_MCP_URL" \
  --ae OPENAI_API_KEY="$OPENAI_API_KEY" \
  --ae RESPONSES_MODEL=gpt-5.6-luna \
  --ae RESPONSES_REASONING_EFFORT=medium
```

Model calls incur costs. Harbor saves results and player trajectories in its job directory; raw artifacts contain private data. Other controls are in [.env.example](.env.example).

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

Import this repository and set these values before deploying:

| Variable                 | Value                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Dedicated Neon database URL.                                                                                              |
| `ARENA_MCP_URL`          | `https://YOUR-DOMAIN/mcp/SECRET`; generate the secret with `openssl rand -hex 32`.                                        |
| `HARBOR_VIEWER_SNAPSHOT` | For traces: snapshot ID from `bun run harbor:snapshot`, using a locally authenticated Vercel CLI linked to the same team. |
| `BLOB_READ_WRITE_TOKEN`  | For traces: a private Vercel Blob store token.                                                                            |

The build applies the schema. Use separate databases per environment. The app and MCP share one origin; browser routes use Vercel Challenge, while MCP must remain publicly reachable. The deployed app does not need `OPENAI_API_KEY`.

## Development

`src/`: game and Arena · `web/`: frontend · `api/`: Vercel functions · `harbor/`: orchestration and viewer.

```bash
bun run db:up
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/pokerbeer bun run check
bun run build
```

Checks include formatting, TypeScript, Ruff, ty, and tests. Python dependencies are managed by `uv`. No paid model calls run during tests.

[MIT](LICENSE)
