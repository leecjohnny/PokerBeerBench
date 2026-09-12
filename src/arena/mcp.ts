import { timingSafeEqual } from 'node:crypto';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { creationSchema, maxTurnIdLength, sha256 } from '../shared.js';
import { ArenaError, ArenaStore, type SeatIdentity } from './db.js';
const empty = z.object({});
const scalarParameters = z
  .record(z.string().max(50), z.union([z.string().max(200), z.number().finite()]))
  .refine((value) => Object.keys(value).length <= 4)
  .optional();
const readOnly = { readOnlyHint: true, idempotentHint: true } as const;
function result(value: object) {
  const payload = { ok: true, ...value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
function failure(error: unknown) {
  const timeout =
    error instanceof Error &&
    (['55P03', '57014'].includes(String((error as NodeJS.ErrnoException).code)) ||
      /timeout|timed out/i.test(error.message));
  const known =
    error instanceof ArenaError
      ? error
      : timeout
        ? new ArenaError('BUSY', 'Arena is busy; retry shortly.', 500)
        : new ArenaError('INTERNAL', 'Arena could not complete the request.');
  const payload = {
    ok: false,
    error: { code: known.code, message: known.message },
    ...(known.retryAfterMs === undefined ? {} : { retry_after_ms: known.retryAfterMs }),
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
async function safe(operation: () => Promise<object>) {
  try {
    return result(await operation());
  } catch (error) {
    return failure(error);
  }
}
function playerServer(store: ArenaStore, identity: SeatIdentity) {
  const server = new McpServer(
    { name: 'pokerbeer-arena', version: '1.0.0' },
    {
      instructions:
        'Begin by calling `get_rules` once, then call `get_status`. Use after_cursor:null initially or for a full refresh; otherwise pass its last next_cursor. Drain has_more before choosing an action. When waiting, wait at least retry_after_ms; waiting is normal. When action_required, call get_actions then submit_action. Stop only when complete.',
    },
  );
  server.registerTool(
    'get_rules',
    {
      description: 'Get the concise tournament rules, actions, scoring, and transitions.',
      inputSchema: empty,
      annotations: readOnly,
    },
    () => safe(() => store.playerRules(identity)),
  );
  server.registerTool(
    'get_status',
    {
      description:
        'Get current decision state and new visible history. Required after_cursor: null for the first call/full refresh, otherwise your last next_cursor. Unchanged biographies/rules/history are omitted on cursor calls. If has_more, call again with next_cursor before acting. Waiting returns retry_after_ms. This cursor is separate from read_inbox.',
      inputSchema: z.object({ after_cursor: z.string().min(1).max(240).nullable() }),
      annotations: readOnly,
    },
    ({ after_cursor }) => safe(() => store.playerStatus(identity, after_cursor)),
  );
  server.registerTool(
    'get_actions',
    {
      description: 'List the exact actions you may submit now.',
      inputSchema: empty,
      annotations: readOnly,
    },
    () => safe(() => store.playerActions(identity)),
  );
  server.registerTool(
    'submit_action',
    {
      description: 'Submit one action returned by get_actions for its current turn.',
      inputSchema: z.object({
        turn_id: z.string().min(1).max(maxTurnIdLength),
        action_id: z.string().min(1).max(100),
        parameters: scalarParameters,
      }),
      annotations: { idempotentHint: true },
    },
    ({ turn_id, action_id, parameters }) =>
      safe(() => store.submitAction(identity, turn_id, action_id, parameters)),
  );
  server.registerTool(
    'read_inbox',
    {
      description: 'Read your delivered messages after an optional cursor.',
      inputSchema: z.object({ after_cursor: z.string().max(20).regex(/^\d+$/).optional() }),
    },
    ({ after_cursor }) => safe(() => store.readInbox(identity, after_cursor)),
  );
  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to one player ID or all. Copy the exact player ID from get_status. If a direct message fails, correct the ID; do not switch to "all" merely to bypass the error. Sending is unavailable during Beer.',
      inputSchema: z.object({ to: z.string().min(1).max(200), text: z.string().max(20_000) }),
    },
    ({ to, text }) => safe(() => store.sendMessage(identity, to, text)),
  );
  return server;
}
function operatorServer(store: ArenaStore, operatorUrl: URL) {
  const server = new McpServer({ name: 'pokerbeer-arena-operator', version: '1.0.0' });
  server.registerTool(
    'create_simulation',
    {
      description: 'Create and immediately start one eight-player simulation.',
      inputSchema: creationSchema,
    },
    (input) => safe(() => store.createSimulation(input, operatorUrl)),
  );
  server.registerTool(
    'get_simulation_state',
    {
      description: 'Read the trusted current observer projection.',
      inputSchema: z.object({ simulation_id: z.string().min(1).max(200) }),
      annotations: readOnly,
    },
    ({ simulation_id }) => safe(() => store.getSimulationState(simulation_id)),
  );
  server.registerTool(
    'get_simulation',
    {
      description: 'Read compact simulation status.',
      inputSchema: z.object({ simulation_id: z.string().min(1).max(200) }),
      annotations: readOnly,
    },
    ({ simulation_id }) => safe(() => store.getSimulation(simulation_id)),
  );
  server.registerTool(
    'export_simulation',
    {
      description: 'Export the result, manifest, and ordered evidence.',
      inputSchema: z.object({ simulation_id: z.string().min(1).max(200) }),
      annotations: readOnly,
    },
    ({ simulation_id }) => safe(() => store.exportSimulation(simulation_id)),
  );
  return server;
}
function identity(auth: AuthInfo | undefined): SeatIdentity {
  const value = auth?.extra as Partial<SeatIdentity> | undefined;
  if (
    !value ||
    typeof value.simulationId !== 'string' ||
    typeof value.playerId !== 'string' ||
    typeof value.seat !== 'number'
  )
    throw new Error('Missing capability identity.');
  return value as SeatIdentity;
}
export function createArenaHttp(store: ArenaStore, configuredUrl: string) {
  const operatorUrl = new URL(configuredUrl);
  if (operatorUrl.search || operatorUrl.hash)
    throw new Error('ARENA_MCP_URL must not contain a query or fragment.');
  const prefix = operatorUrl.pathname.slice(0, operatorUrl.pathname.lastIndexOf('/') + 1);
  const operatorCapability = operatorUrl.pathname.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{32,}$/.test(operatorCapability))
    throw new Error('ARENA_MCP_URL must end in a strong opaque capability.');
  const operatorHash = Buffer.from(sha256(operatorCapability), 'hex');
  const options = { legacy: 'stateless' as const };
  const operator = createMcpHandler(() => operatorServer(store, operatorUrl), options);
  const player = createMcpHandler(
    ({ authInfo }) => playerServer(store, identity(authInfo)),
    options,
  );
  return {
    async fetch(request: Request) {
      const rejected =
        hostHeaderValidationResponse(request, [operatorUrl.hostname]) ??
        originValidationResponse(request, [operatorUrl.hostname]);
      if (rejected) return rejected;
      const url = new URL(request.url);
      if (!url.pathname.startsWith(prefix) || url.hash || (url.search && url.search !== '?create'))
        return new Response('Not found', { status: 404 });
      const capability = url.pathname.slice(prefix.length);
      if (!/^[A-Za-z0-9_-]{32,}$/.test(capability) || capability.includes('/'))
        return new Response('Not found', { status: 404 });
      const digest = Buffer.from(sha256(capability), 'hex');
      if (timingSafeEqual(digest, operatorHash))
        return url.search === '?create'
          ? operator.fetch(request)
          : new Response('Not found', { status: 404 });
      if (url.search) return new Response('Not found', { status: 404 });
      const seat = await store.resolveCapability(digest.toString('hex'));
      if (!seat) return new Response('Not found', { status: 404 });
      return player.fetch(request, {
        authInfo: {
          token: 'path-capability',
          clientId: seat.playerId,
          scopes: ['arena:play'],
          extra: {
            simulationId: seat.simulationId,
            seat: seat.seat,
            playerId: seat.playerId,
          },
        },
      });
    },
    async close() {
      await Promise.all([operator.close(), player.close()]);
    },
  };
}
