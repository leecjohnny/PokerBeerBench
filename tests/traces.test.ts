import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  token: 'a'.repeat(64),
  head: vi.fn(),
  getBlob: vi.fn(),
  issue: vi.fn(),
  presign: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  stop: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@vercel/blob', () => ({
  get: fixture.getBlob,
  head: fixture.head,
  issueSignedToken: fixture.issue,
  presignUrl: fixture.presign,
}));
vi.mock('@vercel/sandbox', () => ({ Sandbox: { create: fixture.create, get: fixture.get } }));
const { default: route } = await import('../api/traces.ts');
const name = `atif-${fixture.token}-12345678-abcd-1234-abcd-123456789abc`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fixture.fetch);
  vi.stubEnv('HARBOR_VIEWER_SNAPSHOT', 'viewer-snapshot');
  fixture.head.mockResolvedValue({});
  fixture.issue.mockResolvedValue('signed-blob-token');
  fixture.presign.mockResolvedValue({
    presignedUrl: 'https://private.blob.test/archive?token=signed',
  });
  fixture.run.mockResolvedValue({ exitCode: 0 });
  fixture.create.mockImplementation(async (options: { name: string }) => ({
    name: options.name,
    runCommand: fixture.run,
    stop: fixture.stop,
  }));
  fixture.get.mockResolvedValue({ status: 'running', domain: () => 'https://viewer.sandbox.test' });
  fixture.fetch.mockResolvedValue(
    new Response('viewer page', { headers: { 'content-type': 'text/html' } }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function launch(token = fixture.token, extra = '') {
  return route.fetch(
    new Request(`https://arena.test/api/traces?open=${encodeURIComponent(token)}${extra}`),
  );
}
it('serves private summary without starting a sandbox', async () => {
  fixture.getBlob.mockResolvedValue({ stream: new Response('{"output_tokens":12}').body });
  const response = await launch(fixture.token, '&summary');
  expect(await response.json()).toEqual({ output_tokens: 12 });
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.head).not.toHaveBeenCalled();
});
it('returns not found for unpublished summaries', async () => {
  fixture.getBlob.mockResolvedValue(null);
  expect((await launch(fixture.token, '&summary')).status).toBe(404);
});
it.each(['&summary=true', '&summary&seat=1', '&summary&summary'])(
  'rejects malformed summary %s',
  async (extra) => {
    expect((await launch(fixture.token, extra)).status).toBe(404);
  },
);
function proxy(path: string, session = name, method = 'GET') {
  return route.fetch(
    new Request(`https://arena.test/api/traces?path=${encodeURIComponent(path)}&limit=10`, {
      method,
      headers: {
        cookie: `other=value; __Host-harbor=${session}`,
        authorization: 'Bearer must-not-forward',
      },
    }),
  );
}

it.each(['习近平', '%E4%B9%A0%E8%BF%91%E5%B9%B3'])(
  'proxies Unicode player path %s',
  async (player) => {
    const path = `/jobs/${fixture.token}/tasks/harbor/pokerbeer-bench/_/_/${player}/trials/seat-3`;
    expect((await proxy(path)).status).toBe(200);
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(String(fixture.fetch.mock.calls[0]![0])).toContain('%E4%B9%A0%E8%BF%91%E5%B9%B3');
  },
);

it('checks archive availability with HEAD without creating a sandbox or signing a URL', async () => {
  const response = await route.fetch(
    new Request(`https://arena.test/api/traces?open=${fixture.token}`, { method: 'HEAD' }),
  );
  expect(response.status).toBe(204);
  expect(fixture.head).toHaveBeenCalledOnce();
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.issue).not.toHaveBeenCalled();
});
it.each(['Satya Nadella', '吳泳銘', 'A/B ?#'])(
  'launches directly into player %s without a session',
  async (player) => {
    const response = await launch(fixture.token, `&${new URLSearchParams({ player, seat: '5' })}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/jobs/${fixture.token}/tasks/harbor/pokerbeer-bench/_/_/${encodeURIComponent(player)}/trials/seat-5`,
    );
  },
);
it.each(['9', '10', '42'])(
  'launches published trial %s beyond the eight game seats',
  async (seat) => {
    const response = await launch(
      fixture.token,
      `&${new URLSearchParams({ player: 'Player', seat })}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/jobs/${fixture.token}/tasks/harbor/pokerbeer-bench/_/_/Player/trials/seat-${seat}`,
    );
  },
);
it.each([
  '&seat=1',
  '&player=A',
  '&player=A&seat=0',
  '&player=A&seat=-1',
  '&player=A&seat=1.5',
  '&player=A&seat=01',
  '&player=A&seat=1&x=y',
  '&player=A&seat=1&seat=2',
])('rejects invalid player link %s', async (extra) => {
  expect((await launch(fixture.token, extra)).status).toBe(404);
  expect(fixture.create).not.toHaveBeenCalled();
});

it.each(['', 'short', 'g'.repeat(64), 'a'.repeat(65), '../archive'])(
  'rejects malformed archive capability %s before accessing resources',
  async (token) => {
    expect((await launch(token)).status).toBe(404);
    expect(fixture.head).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  },
);
it.each(['&open=other', '&path=/jobs'])('rejects ambiguous launch query %s', async (extra) => {
  expect((await launch(fixture.token, extra)).status).toBe(404);
  expect(fixture.head).not.toHaveBeenCalled();
});
it('checks archive existence before signing or launching', async () => {
  fixture.head.mockRejectedValue(new Error('Blob not found'));
  expect((await launch()).status).toBe(410);
  expect(fixture.head).toHaveBeenCalledWith(`atif/${fixture.token}/harbor.tar.gz`);
  expect(fixture.issue).not.toHaveBeenCalled();
  expect(fixture.create).not.toHaveBeenCalled();
});
it('opens the capability without bearer auth and redirects with a secure expiring sandbox session', async () => {
  const start = Date.now();
  const response = await launch();
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`/jobs/${fixture.token}`);
  const pathname = `atif/${fixture.token}/harbor.tar.gz`;
  expect(fixture.head).toHaveBeenCalledWith(pathname);
  expect(fixture.issue).toHaveBeenCalledWith({
    pathname,
    operations: ['get'],
    validUntil: expect.any(Number),
  });
  expect(fixture.issue.mock.calls[0]![0].validUntil).toBeGreaterThanOrEqual(start + 300_000);
  expect(fixture.presign).toHaveBeenCalledWith('signed-blob-token', {
    pathname,
    operation: 'get',
    access: 'private',
  });
  expect(fixture.create).toHaveBeenCalledWith({
    name: expect.stringMatching(new RegExp(`^atif-${fixture.token}-[a-f0-9-]{36}$`)),
    source: { type: 'snapshot', snapshotId: 'viewer-snapshot' },
    persistent: false,
    timeout: 1_800_000,
    ports: [8080],
  });
  const sandboxName = fixture.create.mock.calls[0]![0].name;
  expect(response.headers.get('set-cookie')).toBe(
    `__Host-harbor=${sandboxName}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1800`,
  );
  expect(fixture.run).toHaveBeenCalledWith({
    cmd: 'uv',
    args: ['run', '--offline', '--script', 'viewer.py'],
    detached: true,
    env: {
      ARCHIVE_URL: 'https://private.blob.test/archive?token=signed',
      VIEWER_TOKEN: fixture.token,
    },
  });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(fixture.stop).not.toHaveBeenCalled();
});
it('creates distinct disposable sandboxes when the same archive is reopened', async () => {
  await launch();
  await launch();
  expect(fixture.create.mock.calls[0]![0].name).not.toBe(fixture.create.mock.calls[1]![0].name);
});
it('compresses decoded JSON before CDN caching even when upstream JSON exceeds 10 MB', async () => {
  const body = JSON.stringify({ message: 'large trajectory '.repeat(700000) });
  fixture.fetch.mockResolvedValue(
    new Response(body, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'content-encoding': 'br',
      },
    }),
  );
  const response = await route.fetch(
    new Request(
      `https://arena.test/api/traces?path=${encodeURIComponent(`/api/jobs/${fixture.token}/trials/seat-1/trajectory`)}`,
      { headers: { cookie: `__Host-harbor=${name}`, 'accept-encoding': 'gzip, deflate, br' } },
    ),
  );
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.get('vary')).toBe('Accept-Encoding');
  expect(response.headers.get('vercel-cdn-cache-control')).toBe('public, s-maxage=3600');
  const compressed = await response.arrayBuffer();
  expect(compressed.byteLength).toBeLessThan(100000);
  expect(
    await new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text(),
  ).toBe(body);
});
it.each(['', 'identity', 'br', 'gzip;q=0'])(
  'does not send gzip when not accepted: %s',
  async (encoding) => {
    fixture.fetch.mockResolvedValue(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    const response = await route.fetch(
      new Request(
        `https://arena.test/api/traces?path=${encodeURIComponent(`/api/jobs/${fixture.token}/config`)}`,
        { headers: { cookie: `__Host-harbor=${name}`, 'accept-encoding': encoding } },
      ),
    );
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(await response.text()).toBe('{}');
  },
);
it.each([
  '/assets/app.js',
  '/fonts/font.woff2',
  '/favicon.ico',
  `/jobs/${fixture.token}`,
  `/api/jobs/${fixture.token}/config`,
])('enables Vercel-only caching for %s', async (path) => {
  const response = await proxy(path);
  expect(response.headers.get('vercel-cdn-cache-control')).toBe('public, s-maxage=3600');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it.each([
  '/api/jobs',
  '/api/config',
  '/api/compare',
  '/api/auth/status',
  `/api/jobs/${'b'.repeat(64)}/config`,
  `/jobs/${fixture.token}extra`,
])('never caches cookie-dependent or mismatched path %s', async (path) => {
  expect((await proxy(path)).headers.get('vercel-cdn-cache-control')).toBe('no-store');
});
it.each([302, 404, 410, 500])('never caches upstream status %s', async (status) => {
  fixture.fetch.mockResolvedValue(new Response('response', { status }));
  expect((await proxy(`/jobs/${fixture.token}`)).headers.get('vercel-cdn-cache-control')).toBe(
    'no-store',
  );
});
it.each([{ 'set-cookie': 'secret=value' }, { 'content-length': '10000001' }])(
  'never caches oversized or cookie-setting responses %s',
  async (headers) => {
    fixture.fetch.mockResolvedValue(new Response('response', { headers }));
    expect((await proxy(`/jobs/${fixture.token}`)).headers.get('vercel-cdn-cache-control')).toBe(
      'no-store',
    );
  },
);
it.each(['command', 'health'])('stops the sandbox after a %s failure', async (failure) => {
  if (failure === 'command') fixture.run.mockRejectedValueOnce(new Error('failed'));
  else fixture.run.mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: 1 });
  expect((await launch()).status).toBe(410);
  expect(fixture.stop).toHaveBeenCalledOnce();
});
it('forwards the read-only stream using only the capability derived from the session name', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('chunk'));
      controller.close();
    },
  });
  fixture.fetch.mockResolvedValue(
    new Response(stream, {
      status: 206,
      headers: { 'content-type': 'text/event-stream', 'set-cookie': 'upstream=secret' },
    }),
  );
  const response = await proxy('/api/jobs/archive-job/trials');
  expect(fixture.get).toHaveBeenCalledWith({ name });
  expect(fixture.fetch).toHaveBeenCalledWith(
    new URL('https://viewer.sandbox.test/api/jobs/archive-job/trials?limit=10'),
    {
      method: 'GET',
      headers: { 'x-viewer-token': fixture.token },
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    },
  );
  expect(response.status).toBe(206);
  expect(response.body).toBe(stream);
  expect(await response.text()).toBe('chunk');
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.has('set-cookie')).toBe(false);
});
it.each(['', 'unrelated-sandbox', name.replace('atif-', 'other-'), `atif-${fixture.token}-bad`])(
  'rejects an invalid session namespace %s before sandbox retrieval',
  async (session) => {
    expect((await proxy('/jobs/archive-job', session)).status).toBe(410);
    expect(fixture.get).not.toHaveBeenCalled();
  },
);
it.each(['stopped', 'failed', 'snapshotting'])('does not resume a %s sandbox', async (status) => {
  fixture.get.mockResolvedValue({ status });
  expect((await proxy('/jobs/archive-job')).status).toBe(410);
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.create).not.toHaveBeenCalled();
});
it('returns expiry when the disposable sandbox is gone', async () => {
  fixture.get.mockRejectedValue(new Error('Sandbox not found'));
  expect((await proxy('/jobs/archive-job')).status).toBe(410);
  expect(fixture.create).not.toHaveBeenCalled();
});
it.each([
  '/unknown',
  '/api/auth/login-url',
  '//external.test/jobs',
  '/jobs/archive-job/../../api/auth/login-url',
  '/assets/../api/auth/login-url',
  '/jobs/archive-job/%2e%2e/%2e%2e/api/auth/login-url',
])('rejects disallowed or escaping path %s', async (path) => {
  expect((await proxy(path)).status).toBe(404);
  expect(fixture.get).not.toHaveBeenCalled();
  expect(fixture.fetch).not.toHaveBeenCalled();
});
it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('denies %s writes to viewer APIs', async (method) => {
  expect((await proxy('/api/jobs/archive-job', name, method)).status).toBe(404);
  expect(fixture.get).not.toHaveBeenCalled();
});
