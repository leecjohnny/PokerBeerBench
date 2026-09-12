import { simulationViewerRequest } from '../../src/arena/rest.js';
import { store } from '../../src/arena/vercel.js';

export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    const parts = url.search.slice(1).split('&').filter(Boolean);
    const routed = parts.filter((part) => part.startsWith('simulationId='));
    if (routed.length !== 1 || parts.length !== 1)
      return new Response(JSON.stringify({ error: 'Simulation viewer not found.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    const id = decodeURIComponent(routed[0]!.slice('simulationId='.length));
    return simulationViewerRequest(request, store, id);
  },
};
