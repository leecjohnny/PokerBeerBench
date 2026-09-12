import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('@vercel/blob', () => ({ put }));
import { publishTraces, redactTrace } from '../harbor/viewer/publish';

const directories: string[] = [];
const viewerKey = 'test-viewer-key-with-at-least-32-characters';
const capability = createHmac('sha256', viewerKey).update('atif:simulation-1').digest('hex');
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  put.mockReset();
});
async function fixture(count = 8) {
  await mkdir(join(process.cwd(), '.local'), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.local', 'test-publication-'));
  directories.push(directory);
  const trial = join(directory, 'source');
  await mkdir(join(trial, 'agent'), { recursive: true });
  const child = (index: number) => ({
    schema_version: 'ATIF-future',
    session_id: `session-${index}`,
    agent: {
      version: 'harness-next',
      extra: index === 1 ? {} : { player_id: `玩家 ${index}` },
    },
    future_field: { attachments: [{ format: 'new-format', reference: 'opaque-value' }] },
    steps: [
      {
        message: '',
        extra: {
          nativeResponse: { usage: { input_tokens: 31 }, private_detail: 'retain me' },
          response: {
            created_at: 100 + index,
            completed_at: 200 + index,
            output: [{ content: [{ text: '完整消息' }] }],
          },
        },
      },
    ],
  });
  const trajectory = {
    schema_version: 'ATIF-future',
    final_metrics: { total_completion_tokens: 1234 },
    extra: {
      simulation_id: 'simulation-1',
      harness: { version: 'next', future_field: ['preserve'] },
    },
    subagent_trajectories: Array.from({ length: count }, (_, i) => child(i)),
  };
  const result = {
    started_at: '2026-09-11T23:00:00Z',
    finished_at: '2026-09-12T00:00:00Z',
    config: {
      task: { path: 'harbor/task', future_task_option: 'retain me' },
      agent: {
        env: { OPENAI_API_KEY: 'secret', DESCRIPTION: `embedded ${viewerKey} value` },
        env_vars: { MODEL: 'internal-env-marker' },
      },
    },
    agent_info: { name: 'new-harness', version: '2', future_option: true },
    verifier_result: { rewards: { valid: 1 } },
  };
  await writeFile(join(trial, 'result.json'), JSON.stringify(result));
  await writeFile(
    join(directory, 'config.json'),
    JSON.stringify({
      job_name: 'original',
      agents: [{ env_vars: { MODEL: 'internal-env-marker' } }],
    }),
  );
  await writeFile(join(trial, 'agent/trajectory.json'), JSON.stringify(trajectory));
  return { directory, trial, trajectory };
}
test('redacts credentials in objects, embedded JSON and URLs without stripping response usage', () => {
  const secret = 'A'.repeat(40);
  const value = {
    env: { PUBLIC_SETTING: 'internal-env-marker' },
    env_vars: { OTHER_SETTING: 'internal-env-marker' },
    nestedEnvironment: JSON.stringify({
      environment_variables: { SETTING: 'internal-env-marker' },
    }),
    apiKey: secret,
    ACCESS_TOKEN: secret,
    operatorCapability: secret,
    nativeResponse: { usage: { input_tokens: 41 }, output: [{ text: 'full response' }] },
    nested: JSON.stringify({ authorization: `Bearer ${secret}`, key: secret }),
    message: `https://arena.test/mcp/${secret} https://arena.test/view?key=${secret} postgres://user:${secret}@db.test/database postgresql://user:${secret}@db.test/database`,
  };
  const serialized = JSON.stringify(value, redactTrace);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('internal-env-marker');
  expect(JSON.parse(serialized)).not.toHaveProperty('env');
  expect(JSON.parse(serialized)).not.toHaveProperty('env_vars');
  expect(JSON.parse(serialized).nativeResponse).toEqual(value.nativeResponse);
});
test('preserves player-keyed results even when player IDs resemble credential names', () => {
  const results = {
    stacks: { api_key: 540000, token: 0, env: 0 },
    teams: { api_key: ['token', 'env'], env: ['api_key'], token: ['other'] },
    showdownRanks: {
      api_key: { category: 6, kickers: [12, 4] },
      token: { category: 2, kickers: [9, 8] },
      env: { category: 1, kickers: [14, 13] },
    },
  };
  const value = { results, embedded: JSON.stringify(results) };
  expect(JSON.parse(JSON.stringify(value, redactTrace))).toEqual(value);
});
test.each([0, 3, 8, 10])(
  'uploads a native archive with root plus %i unmodified trajectories',
  async (count) => {
    const { directory, trial, trajectory } = await fixture(count);
    put.mockImplementation(async (path: string, stream: Readable, options: unknown) => {
      if (path.endsWith('/summary.json')) {
        expect(JSON.parse(String(stream))).toEqual({
          duration_seconds: 3600,
          output_tokens: 1234,
          trajectories: trajectory.subagent_trajectories.map((child, index) => ({
            ...(child.agent.extra.player_id && { player_id: child.agent.extra.player_id }),
            seat: String(index + 1),
          })),
        });
        expect(options).toMatchObject({ access: 'private' });
        return { url: 'https://store.private.blob.vercel-storage.com/summary' };
      }
      expect(path).toBe(`atif/${capability}/harbor.tar.gz`);
      expect(options).toMatchObject({ access: 'private', multipart: true, allowOverwrite: true });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const archive = join(directory, 'captured.tar.gz');
      await writeFile(archive, Buffer.concat(chunks));
      execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' });
      return { url: 'https://store.private.blob.vercel-storage.com/archive' };
    });
    expect(await publishTraces(trial, 'simulation-1', viewerKey)).toContain('.private.blob.');
    const job = join(directory, capability);
    for (const name of [
      'config.json',
      'root/config.json',
      'root/result.json',
      ...(count ? ['seat-1/config.json', 'seat-1/result.json'] : []),
    ]) {
      const text = await readFile(join(job, name), 'utf8');
      expect(text).not.toContain('internal-env-marker');
      expect(text).not.toMatch(/"env(?:_vars)?":/);
    }
    expect((await readdir(job)).filter((name) => name !== 'config.json')).toHaveLength(count + 1);
    const root = JSON.parse(await readFile(join(job, 'root/agent/trajectory.json'), 'utf8'));
    expect(root).toEqual(trajectory);
    expect(JSON.parse(await readFile(join(job, 'root/config.json'), 'utf8')).task).toEqual({
      path: 'harbor/task',
      future_task_option: 'retain me',
    });
    for (let index = 1; index <= count; index++) {
      const player = join(job, `seat-${index}`);
      const original = trajectory.subagent_trajectories[index - 1]!;
      const taskName = original.agent.extra.player_id ?? `seat-${index}`;
      expect(JSON.parse(await readFile(join(player, 'agent/trajectory.json'), 'utf8'))).toEqual(
        original,
      );
      const publishedResult = JSON.parse(await readFile(join(player, 'result.json'), 'utf8'));
      expect(publishedResult).toMatchObject({
        task_name: taskName,
        verifier_result: null,
        agent_result: null,
        agent_info: { name: 'new-harness', version: '2', future_option: true },
      });
      expect(publishedResult.config.agent).toEqual({});
      expect(await readFile(join(player, 'config.json'), 'utf8')).not.toContain('secret');
      expect(await readFile(join(player, 'config.json'), 'utf8')).not.toContain(viewerKey);
      expect(JSON.parse(await readFile(join(player, 'config.json'), 'utf8')).task).toEqual({
        name: taskName,
      });
    }
    expect((await readdir(directory)).some((name) => name.startsWith('.publish-'))).toBe(false);
  },
);
test('rejects mismatched IDs before upload and cleans generated files on upload failure', async () => {
  const { directory, trial } = await fixture();
  await expect(publishTraces(trial, '../wrong', viewerKey)).rejects.toThrow('Simulation ID');
  expect(put).not.toHaveBeenCalled();
  put.mockImplementation(async (_path: string, stream: Readable) => {
    for await (const chunk of stream) void chunk;
    throw new Error('Upload failed');
  });
  await expect(publishTraces(trial, 'simulation-1', viewerKey)).rejects.toThrow('Upload failed');
  expect((await readdir(directory)).some((name) => name.startsWith('.publish-'))).toBe(false);
});
test.each([{}, { finished_at: '2026-09-12', exception_info: { exception_type: 'Failed' } }])(
  'rejects unfinished or failed native Harbor results',
  async (result) => {
    const { trial } = await fixture();
    await writeFile(join(trial, 'result.json'), JSON.stringify(result));
    await expect(publishTraces(trial, 'simulation-1', viewerKey)).rejects.toThrow(
      'completed Harbor trial',
    );
    expect(put).not.toHaveBeenCalled();
  },
);
