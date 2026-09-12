import { get, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { Sandbox } from '@vercel/sandbox';
import { randomUUID } from 'node:crypto';

const ttl = 1800;
const cookie = '__Host-harbor';
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };
const allowed =
  /^\/(?:jobs(?:\/|$)|assets\/|fonts\/|compare$|favicon\.ico$|api\/(?:jobs(?:\/|$)|config$|health$|pricing$|compare$|auth\/status$))/;

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    try {
      if (['GET', 'HEAD'].includes(request.method) && url.searchParams.has('open')) {
        const token = url.searchParams.get('open') ?? '';
        const player = url.searchParams.get('player');
        const seat = url.searchParams.get('seat');
        const summary = url.searchParams.has('summary');
        if (
          !/^[a-f0-9]{64}$/.test(token) ||
          (summary && url.searchParams.get('summary') !== '') ||
          [...url.searchParams].length !==
            (summary ? 2 : player && /^[1-9]\d*$/.test(seat ?? '') ? 3 : 1)
        )
          return new Response('Not found', { status: 404, headers });
        if (summary) {
          const blob = await get(`atif/${token}/summary.json`, {
            access: 'private',
            useCache: false,
          });
          return new Response(blob?.stream, {
            status: blob ? 200 : 404,
            headers: { ...headers, 'content-type': 'application/json' },
          });
        }
        const pathname = `atif/${token}/harbor.tar.gz`;
        await head(pathname);
        if (request.method === 'HEAD') return new Response(null, { status: 204, headers });
        const signed = await issueSignedToken({
          pathname,
          operations: ['get'],
          validUntil: Date.now() + 300_000,
        });
        const archive = await presignUrl(signed, { pathname, operation: 'get', access: 'private' });
        const sandbox = await Sandbox.create({
          name: `atif-${token}-${randomUUID()}`,
          source: { type: 'snapshot', snapshotId: process.env.HARBOR_VIEWER_SNAPSHOT! },
          persistent: false,
          timeout: ttl * 1000,
          ports: [8080],
        });
        try {
          await sandbox.runCommand({
            cmd: 'uv',
            args: ['run', '--offline', '--script', 'viewer.py'],
            detached: true,
            env: { ARCHIVE_URL: archive.presignedUrl, VIEWER_TOKEN: token },
          });
          const ready = await sandbox.runCommand({
            cmd: 'sh',
            args: [
              '-c',
              'curl -fsS --retry 40 --retry-connrefused --retry-delay 1 --max-time 2 -H "x-viewer-token: $VIEWER_TOKEN" http://localhost:8080/api/health',
            ],
            env: { VIEWER_TOKEN: token },
          });
          if (ready.exitCode) throw new Error('Viewer did not start.');
          return new Response(null, {
            status: 302,
            headers: {
              ...headers,
              location: `/jobs/${token}${player ? `/tasks/harbor/pokerbeer-bench/_/_/${encodeURIComponent(player)}/trials/seat-${seat}` : ''}`,
              'set-cookie': `${cookie}=${sandbox.name}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttl}`,
            },
          });
        } catch (error) {
          await sandbox.stop();
          throw error;
        }
      }
      const paths = url.searchParams.getAll('path');
      const path = paths[0] ?? '';
      if (
        !['GET', 'HEAD'].includes(request.method) ||
        paths.length !== 1 ||
        !allowed.test(path) ||
        decodeURI(new URL(path, url).pathname) !== decodeURI(path)
      )
        return new Response('Not found', { status: 404, headers });
      const name =
        request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-harbor=([^;]+)/)?.[1] ?? '';
      const token = /^atif-([a-f0-9]{64})-[a-f0-9-]{36}$/.exec(name)?.[1];
      if (!token) throw new Error('Missing viewer session.');
      const sandbox = await Sandbox.get({ name });
      if (sandbox.status !== 'running') throw new Error('Viewer expired.');
      url.searchParams.delete('path');
      const upstream = new URL(path + url.search, sandbox.domain(8080));
      const response = await fetch(upstream, {
        method: request.method,
        headers: { 'x-viewer-token': token },
        redirect: 'manual',
        signal: AbortSignal.timeout(45_000),
      });
      const gzip =
        response.status === 200 &&
        response.body &&
        response.headers.get('content-type')?.includes('application/json') &&
        /(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers.get('accept-encoding') ?? '');
      const cacheable =
        response.status === 200 &&
        !response.headers.has('set-cookie') &&
        (gzip || Number(response.headers.get('content-length') ?? 0) <= 10_000_000) &&
        new RegExp(`^/(?:assets/|fonts/|favicon\\.ico$|(?:api/)?jobs/${token}(?:/|$))`).test(path);
      return new Response(
        gzip ? response.body!.pipeThrough(new CompressionStream('gzip')) : response.body,
        {
          status: response.status,
          headers: {
            ...headers,
            ...(gzip && { 'content-encoding': 'gzip' }),
            vary: 'Accept-Encoding',
            'vercel-cdn-cache-control': cacheable ? 'public, s-maxage=3600' : 'no-store',
            'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
          },
        },
      );
    } catch {
      return new Response('Viewer unavailable or expired. Reopen the original ATIF link.', {
        status: 410,
        headers,
      });
    }
  },
};
