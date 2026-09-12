import { readFile } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';

const migrate = vi.hoisted(() => vi.fn());
vi.mock('../src/arena/vercel.ts', () => ({ store: { migrate } }));
beforeEach(() => {
  vi.resetModules();
  migrate.mockReset();
});

it('documents deployment prerequisites without binding to a repository', async () => {
  const readme = await readFile('README.md', 'utf8');
  expect(readme).toContain(
    '[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)',
  );
  for (const variable of [
    'DATABASE_URL',
    'ARENA_MCP_URL',
    'HARBOR_VIEWER_SNAPSHOT',
    'BLOB_READ_WRITE_TOKEN',
  ])
    expect(readme).toContain(`| \`${variable}\``);
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
