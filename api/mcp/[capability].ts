import { arena, operatorUrl } from '../../src/arena/vercel.js';

export default {
  fetch(request: Request) {
    const incoming = new URL(request.url);
    const parts = incoming.search.slice(1).split('&').filter(Boolean);
    const routed = parts.filter((part) => part.startsWith('capability='));
    if (routed.length !== 1) return new Response('Not found', { status: 404 });
    const capability = decodeURIComponent(routed[0]!.slice('capability='.length));
    const target = new URL(operatorUrl);
    target.pathname = target.pathname.replace(/[^/]+$/, () => capability);
    const external = parts.filter((part) => part !== routed[0]);
    target.search = external.length ? `?${external.join('&')}` : '';
    return arena.fetch(new Request(target, request));
  },
};
