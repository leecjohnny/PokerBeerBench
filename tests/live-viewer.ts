// Explicit live acceptance, not loaded by Vitest. Requires Development Blob/Sandbox credentials.
import { readFile, writeFile } from 'node:fs/promises';
import { Sandbox } from '@vercel/sandbox';
import { publishTraces } from '../harbor/viewer/publish.ts';
import { traceCapability } from '../src/shared.ts';
import route from '../api/traces.ts';
import assert from 'node:assert/strict';

const [trialDir, allocationPath] = process.argv.slice(2);
assert(trialDir && allocationPath && process.env.HARBOR_VIEWER_SNAPSHOT);
const allocation = JSON.parse(await readFile(allocationPath, 'utf8'));
const id = allocation.simulation_id;
const opaque = traceCapability(id, allocation.viewer.key);
await publishTraces(trialDir, id, allocation.viewer.key);
const origin = new URL(allocation.viewer.url).origin;
const started = await route.fetch(new Request(`${origin}/api/traces?open=${opaque}`));
assert.equal(started.status, 302, await started.clone().text());
const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
const sandbox = await Sandbox.get({ name: cookie.split('=')[1]! });
try {
  assert.equal((await fetch(sandbox.domain(8080))).status, 403);
  const proxy = (path: string) =>
    route.fetch(
      new Request(`${origin}/api/traces?path=${encodeURIComponent(path)}`, { headers: { cookie } }),
    );
  const page = await proxy(`/jobs/${opaque}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const counts = [];
  for (let seat = 1; seat <= 8; seat++) {
    const response = await proxy(`/api/jobs/${opaque}/trials/seat-${seat}/trajectory`);
    assert.equal(response.status, 200);
    const trajectory = await response.json();
    assert(trajectory.steps.length > 0);
    counts.push({ player: trajectory.agent.extra.player_id, turns: trajectory.steps.length });
  }
  await sandbox.stop();
  assert.equal((await proxy('/api/config')).status, 410);
  const result = { simulation_id: id, viewer_url: `${origin}/atif_view/${opaque}/`, counts };
  await writeFile('.local/harbor-viewer-acceptance.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ simulation_id: id, players: counts.length, passed: true }));
} finally {
  await sandbox.stop();
}
