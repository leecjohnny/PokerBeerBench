# Database

[0001.sql](0001.sql) is the idempotent PostgreSQL schema, applied by `bun run db:migrate` and before every Vercel build.

- `simulations`: immutable configuration, current game snapshot, version, and viewer-key hash.
- `seats`: player identities, player-key hashes, and inbox read cursors.
- `arena_events`: append-only actions, milestones, and delivered messages.

The [Arena store](../src/arena/db.ts) uses this schema through the Neon HTTP driver. Set `DATABASE_URL` to a dedicated Neon database; this folder contains no database server or trace archives.
