import { ZodError } from 'zod';
import { ArenaError, type ArenaStore } from './db.js';

const headers = {
  'cache-control': 'private, no-store',
  'content-type': 'application/json',
  vary: 'authorization',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });
const failure = (error: unknown) => {
  if (error instanceof ZodError)
    return json({ error: 'Invalid simulation input.', issues: error.issues }, 400);
  if (error instanceof ArenaError && error.code === 'NOT_FOUND')
    return json({ error: 'Simulation viewer not found.' }, 404);
  if (error instanceof ArenaError && error.code === 'INVALID_CONFIG')
    return json({ error: error.message }, 400);
  console.error(
    'simulation_request_failed',
    error instanceof ArenaError ? error.code : error instanceof Error ? error.name : 'unknown',
  );
  return json({ error: 'Request failed.' }, 500);
};

export async function createSimulationRequest(
  request: Request,
  store: ArenaStore,
  operatorUrl: URL,
) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return json({ error: 'Content-Type must be application/json.' }, 415);
  try {
    return json(await store.createSimulation(await request.json(), operatorUrl), 201);
  } catch (error) {
    return failure(error);
  }
}

export async function simulationViewerRequest(request: Request, store: ArenaStore, id: string) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) return json({ error: 'Simulation viewer not found.' }, 404);
  try {
    return json(await store.getViewerState(id, match[1]!));
  } catch (error) {
    return failure(error);
  }
}
