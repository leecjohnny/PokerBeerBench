# PokerBeerBench

[Read the write-up: design and example simulations](https://docs.google.com/document/d/1F1zMMxKeQEHc5OsUI_rgj1PvWtCoIMCkwHsai-8aTps/edit?usp=drivesdk).

Eight players with public biographies and private goals compete through **Poker A → Draft → Beer → Poker B**, testing deception, cooperation, and repeated encounters.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fleecjohnny%2FPokerBeerBench&project-name=pokerbeer-bench&repository-name=PokerBeerBench&env=DATABASE_URL%2CARENA_MCP_SECRET&envDescription=A%20dedicated%20Neon%20database%20URL%20and%20a%20random%20MCP%20secret.&envLink=https%3A%2F%2Fgithub.com%2Fleecjohnny%2FPokerBeerBench%23deploy)

Provide a dedicated Neon `DATABASE_URL` and `ARENA_MCP_SECRET` (`openssl rand -hex 32`). Vercel supplies the hostname (keep System Environment Variables enabled) and applies the schema during build; use separate databases per environment. Browser routes use Vercel Challenge; MCP must remain publicly reachable.

Optional trace viewer: connect a private Blob store (`BLOB_READ_WRITE_TOKEN`) and set `HARBOR_VIEWER_SNAPSHOT` from `bun run harbor:snapshot`, using a local Vercel CLI authenticated and linked to the same project. Other settings: [.env.example](.env.example).

## Play without Harbor

Open your deployment, create a game, and connect one MCP-capable agent per player URL. Save the viewer URL and key. The website does not launch agents; keep player URLs, viewer keys, and private goals private.

Give each agent this instruction:

> Begin by calling `get_rules` once, then `get_status` with `after_cursor: null`. Continue until complete: follow polling hints, pass `next_cursor` on later status calls, drain `has_more`, read unread messages, and submit legal actions.

For a local app, use Bun 1.3.13, Node 24, and a development Neon database:

```bash
bun install --frozen-lockfile
cp .env.example .env.local
# Edit .env.local: set DATABASE_URL and ARENA_MCP_SECRET.
bun run db:migrate
bun run arena:vercel:dev
```

Open <http://localhost:3100> and connect agents as above.

## Run with Harbor

Harbor runs all eight players through OpenAI Responses and saves results and trajectories. Install Bun, Docker, and `uv`; export `OPENAI_API_KEY`, `ARENA_ORIGIN=https://your-domain.example`, and the deployed Arena's `ARENA_MCP_SECRET`.

```bash
bun run harbor:build
PYTHONPATH="$PWD/harbor" uv run --locked harbor run \
  -p harbor -a pokerbeer_harbor_agent:PokerBeerBenchAgent -e docker \
  --n-concurrent 1 \
  --ae ARENA_ORIGIN="$ARENA_ORIGIN" \
  --ae ARENA_MCP_SECRET="$ARENA_MCP_SECRET" \
  --ae OPENAI_API_KEY="$OPENAI_API_KEY"
```

Defaults: `gpt-5.6-luna`, medium reasoning; calls incur costs and artifacts contain private data. Rules: [benchmark profile](configs/benchmark.json). For a local Arena, set the same public HTTPS tunnel origin on the app and Harbor; OpenAI cannot reach localhost.

Inspired by and submitted to ChinaTalk's [Evals for the Situation Room contest](https://www.chinatalk.media/p/25k-contest-evals-for-the-situation). [MIT](LICENSE).
