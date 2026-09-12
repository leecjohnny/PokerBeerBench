import { createSimulationRequest } from '../src/arena/rest.js';
import { operatorUrl, store } from '../src/arena/vercel.js';

export default {
  fetch: (request: Request) => createSimulationRequest(request, store, operatorUrl),
};
