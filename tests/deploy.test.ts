import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveOperatorUrl } from '../src/arena/config.ts';

const migrate = vi.hoisted(() => vi.fn());
vi.mock('../src/arena/vercel.ts', () => ({ store: { migrate } }));
beforeEach(() => {
  vi.resetModules();
  migrate.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const secret = 'a'.repeat(64);
it.each<[string, NodeJS.ProcessEnv, string]>([
  ['local default', {}, 'http://localhost:3100'],
  ['local override', { ARENA_ORIGIN: 'http://127.0.0.1:3200' }, 'http://127.0.0.1:3200'],
  [
    'production',
    {
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'production.test',
      VERCEL_URL: 'deployment.test',
    },
    'https://production.test',
  ],
  [
    'preview',
    {
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_PRODUCTION_URL: 'production.test',
      VERCEL_URL: 'preview.test',
    },
    'https://preview.test',
  ],
  [
    'development with pulled Vercel variables',
    {
      VERCEL_ENV: 'development',
      VERCEL_URL: 'deployment.test',
      VERCEL_PROJECT_PRODUCTION_URL: 'production.test',
    },
    'http://localhost:3100',
  ],
  [
    'explicit tunnel override',
    {
      ARENA_ORIGIN: 'https://tunnel.test/',
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'production.test',
    },
    'https://tunnel.test',
  ],
])('resolves the %s address independently of its secret', (_name, env, origin) => {
  const url = resolveOperatorUrl({ ...env, ARENA_MCP_SECRET: secret });
  expect(url.href).toBe(`${origin}/mcp/${secret}`);
  expect(new URL('player-capability', url).href).toBe(`${origin}/mcp/player-capability`);
  expect(new URL('/simulations/sim-1', url).href).toBe(`${origin}/simulations/sim-1`);
});

it.each([
  undefined,
  '',
  'short',
  'a'.repeat(32) + '/other',
  'a'.repeat(32) + '?create',
  'a'.repeat(32) + '#secret',
])('rejects a missing, weak or URL-shaped secret (%s)', (value) => {
  expect(() => resolveOperatorUrl({ ARENA_MCP_SECRET: value })).toThrow();
});
it.each(['example.test', 'not a URL', 'javascript:alert(1)'])(
  'rejects an unusable origin (%s)',
  (origin) => {
    expect(() => resolveOperatorUrl({ ARENA_MCP_SECRET: secret, ARENA_ORIGIN: origin })).toThrow();
  },
);
it('keeps only the origin when building capability links', () => {
  expect(
    resolveOperatorUrl({
      ARENA_MCP_SECRET: secret,
      ARENA_ORIGIN: 'https://user:password@arena.test/path?secret=value#fragment',
    }).href,
  ).toBe(`https://arena.test/mcp/${secret}`);
});

it('initializes the deployed Arena without a manually configured hostname', async () => {
  vi.stubEnv('ARENA_ORIGIN', undefined);
  vi.stubEnv('ARENA_MCP_SECRET', secret);
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'production.test');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:password@database.test/test');
  const { arena, operatorUrl } =
    await vi.importActual<typeof import('../src/arena/vercel.ts')>('../src/arena/vercel.ts');
  try {
    expect(operatorUrl.href).toBe(`https://production.test/mcp/${secret}`);
    const response = await arena.fetch(
      new Request(`${operatorUrl.href}?create`, { headers: { host: operatorUrl.host } }),
    );
    expect(response.status).toBe(405);
  } finally {
    await arena.close();
  }
});

it('lets the database SDK reject a missing database URL', async () => {
  vi.stubEnv('ARENA_MCP_SECRET', secret);
  vi.stubEnv('DATABASE_URL', undefined);
  await expect(vi.importActual('../src/arena/vercel.ts')).rejects.toThrow(
    /No database connection string/,
  );
});

it('clones the public template and prompts for required deployment settings', async () => {
  const readme = await readFile('README.md', 'utf8');
  const button = new URL(readme.match(/\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/)![1]!);
  expect(button.searchParams.get('repository-url')).toBe(
    'https://github.com/leecjohnny/PokerBeerBench',
  );
  expect(button.searchParams.get('env')).toBe('DATABASE_URL,ARENA_MCP_SECRET');
  expect(button.searchParams.get('envLink')).toBe(
    'https://github.com/leecjohnny/PokerBeerBench#deploy-on-vercel',
  );
  expect(button.searchParams.has('envDefaults')).toBe(false);
  for (const variable of [
    'DATABASE_URL',
    'ARENA_MCP_SECRET',
    'HARBOR_VIEWER_SNAPSHOT',
    'BLOB_READ_WRITE_TOKEN',
  ])
    expect(readme).toContain(`\`${variable}\``);
});

it('runs the shared schema migration before the Vercel frontend build', async () => {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  expect(config.buildCommand).toBe('bun run db:migrate && bun run build');
  await import('../scripts/migrate.ts');
  expect(migrate).toHaveBeenCalledOnce();
  expect(await readFile('src/arena/vercel.ts', 'utf8')).not.toContain('.migrate(');
});

it('fails deployment when migration fails instead of publishing an uninitialized app', async () => {
  migrate.mockRejectedValue(new Error('Database unavailable'));
  await expect(import('../scripts/migrate.ts')).rejects.toThrow('Database unavailable');
});
