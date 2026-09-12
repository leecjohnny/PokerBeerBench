import { createMCPClient } from '@ai-sdk/mcp';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import type { CreationInput } from '../../src/shared.ts';
import { buildAtif, errorDetails, type HarnessOutcome, type ReasoningLevel } from './atif.ts';
import {
  ARENA_TOOL_NAMES,
  hasExactArenaTools,
  isTrustedSeatUrl,
  resolveResponseSeats,
  runResponsesSeat,
  type ResponseEvent,
  type ResponsesSeatInput,
} from './responses.ts';
export { ARENA_TOOL_NAMES } from './responses.ts';
type McpResponse = { isError?: boolean; structuredContent?: unknown };
export interface TrialMcpClient {
  listTools(input: {
    params?: { cursor: string };
    options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number };
  }): Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>;
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number };
  }): Promise<McpResponse>;
  close(): Promise<void>;
}
export interface TrialDependencies {
  connectMcp(url: string, signal: AbortSignal): Promise<TrialMcpClient>;
  runSeat(input: ResponsesSeatInput): Promise<OpenAIResponse[]>;
  resolveSeats: typeof resolveResponseSeats;
}
export interface TrialOptions {
  creation: CreationInput;
  arenaMcpUrl: string;
  model: string;
  reasoning: ReasoningLevel;
  instruction: string;
  trialId: string;
  sessionName: string;
  timeoutMs: number;
  resumeIds?: string[];
  abortSignal?: AbortSignal;
}
type TrialOutput = {
  result: unknown;
  arena: Record<string, any> | null;
  harness: HarnessOutcome;
  trajectory: ReturnType<typeof buildAtif>;
};
export class TrialFailure extends Error {
  constructor(
    error: unknown,
    readonly output: TrialOutput,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'TrialFailure';
  }
}
const payload = (response: McpResponse): Record<string, any> => {
  if (response.isError) throw new Error('Arena rejected an operator request.', { cause: response });
  if (!response.structuredContent || typeof response.structuredContent !== 'object')
    throw new Error('Arena returned no structured response.');
  return response.structuredContent as Record<string, any>;
};
const creatorUrl = (base: string): string => {
  const url = new URL(base);
  if (url.search || url.hash)
    throw new Error('ARENA_MCP_URL must not contain a query or fragment.');
  url.search = 'create';
  return url.href;
};
const officialDependencies: TrialDependencies = {
  async connectMcp(url, signal) {
    return (await createMCPClient({
      transport: { type: 'http', url },
      initializationOptions: { timeout: 5_000, signal },
    })) as TrialMcpClient;
  },
  runSeat: runResponsesSeat,
  resolveSeats: resolveResponseSeats,
};
function assertTools(tools: string[]): void {
  if (!hasExactArenaTools(tools))
    throw new Error(`Seat MCP must expose exactly: ${ARENA_TOOL_NAMES.join(', ')}.`);
}
export async function runTrial(
  options: TrialOptions,
  deps: TrialDependencies = officialDependencies,
) {
  const abort = new AbortController();
  const timeoutError = new Error('Trial timed out.');
  const timer = setTimeout(() => abort.abort(timeoutError), options.timeoutMs);
  const signal = options.abortSignal
    ? AbortSignal.any([abort.signal, options.abortSignal])
    : abort.signal;
  const clients: TrialMcpClient[] = [];
  const operatorCalls: unknown[] = [];
  const resumeEvents: ResponseEvent[] = [];
  const traces: Array<{
    playerId: string;
    sessionId: string;
    responses: OpenAIResponse[];
    errors: ResponseEvent[];
    mcpCalls: unknown[];
  }> = [];
  let operator: TrialMcpClient | undefined;
  let simulationId: string | null = null;
  let failure: unknown;
  const harness: HarnessOutcome = { status: 'completed' };
  const operatorCall = async (
    name: string,
    args: Record<string, unknown>,
    callSignal?: AbortSignal,
  ) => {
    const request = { name, arguments: args };
    try {
      const response = await operator!.callTool({
        ...request,
        options: {
          ...(callSignal ? { signal: callSignal } : {}),
          timeout: 5_000,
          maxTotalTimeout: 15_000,
        },
      });
      operatorCalls.push({ ...request, response });
      return payload(response);
    } catch (error) {
      operatorCalls.push({ ...request, error: errorDetails(error) });
      throw error;
    }
  };
  try {
    const resumed = options.resumeIds
      ? await deps.resolveSeats(
          options.resumeIds,
          options.model,
          options.reasoning,
          options.arenaMcpUrl,
          options.creation.players.map(({ id }) => id),
          undefined,
          signal,
          (event) => {
            resumeEvents.push(event);
          },
        )
      : undefined;
    const operatorBase = new URL(options.arenaMcpUrl);
    operator = await deps.connectMcp(creatorUrl(options.arenaMcpUrl), signal);
    clients.push(operator);
    const created = resumed
      ? {
          ok: true,
          simulation_id: resumed[0]!.simulationId,
          players: resumed.map((seat) => ({
            player_id: seat.playerId,
            mcp_url: seat.url,
            resume_id: seat.resumeId,
          })),
        }
      : await operatorCall(
          'create_simulation',
          options.creation as Record<string, unknown>,
          signal,
        );
    if (
      created.ok !== true ||
      typeof created.simulation_id !== 'string' ||
      !Array.isArray(created.players)
    )
      throw new Error('Arena returned an invalid simulation allocation.');
    simulationId = created.simulation_id;
    if (!resumed && process.env.HARBOR_ALLOCATION_PATH)
      await writeFile(
        process.env.HARBOR_ALLOCATION_PATH,
        JSON.stringify({ simulation_id: simulationId, viewer: created.viewer }),
        { mode: 0o600 },
      );
    const checkpoint = await operatorCall(
      'get_simulation',
      { simulation_id: simulationId },
      signal,
    );
    const configHash = checkpoint.config_hash;
    if (
      checkpoint.ok !== true ||
      checkpoint.simulation_id !== simulationId ||
      typeof configHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(configHash) ||
      (resumed && resumed.some((seat) => seat.configHash !== configHash))
    )
      throw new Error('Simulation checkpoint does not match the Responses seats.');
    const seats = created.players.map((raw: Record<string, unknown>) => {
      if (
        typeof raw.player_id !== 'string' ||
        typeof raw.mcp_url !== 'string' ||
        (raw.resume_id !== undefined && typeof raw.resume_id !== 'string')
      )
        throw new Error('Arena returned an invalid seat allocation.');
      if (!isTrustedSeatUrl(operatorBase, new URL(raw.mcp_url)))
        throw new Error('Arena returned an untrusted seat endpoint.');
      return { playerId: raw.player_id, url: raw.mcp_url, resumeId: raw.resume_id as string };
    });
    const playerIds = options.creation.players.map(({ id }) => id);
    const expectedPlayers = [...playerIds].sort();
    if (
      seats.length !== 8 ||
      new Set(seats.map(({ playerId }) => playerId)).size !== 8 ||
      new Set(seats.map(({ url }) => url)).size !== 8 ||
      seats
        .map(({ playerId }) => playerId)
        .sort()
        .some((id, index) => id !== expectedPlayers[index])
    )
      throw new Error('Arena must allocate eight unique Responses seats.');
    // Resume IDs can be supplied in any order; filenames retain the configured seat order.
    seats.sort((a, b) => playerIds.indexOf(a.playerId) - playerIds.indexOf(b.playerId));
    const prepared = [];
    for (const [index, seat] of seats.entries()) {
      const trace = {
        playerId: seat.playerId,
        sessionId: `${simulationId}-${seat.playerId}`,
        responses: [] as OpenAIResponse[],
        errors: [] as ResponseEvent[],
        mcpCalls: [] as unknown[],
      };
      traces.push(trace);
      const client = await deps.connectMcp(seat.url, signal);
      clients.push(client);
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({
          ...(cursor ? { params: { cursor } } : {}),
          options: { signal, timeout: 5_000, maxTotalTimeout: 15_000 },
        });
        names.push(...page.tools.map(({ name }) => name));
        cursor = page.nextCursor;
      } while (cursor);
      assertTools(names);
      prepared.push({ ...seat, client, trace, seat: index + 1 });
    }
    let turnChanged = new AbortController();
    const runs = prepared.map(async ({ playerId, url, resumeId, client, trace, seat }) => {
      let observedTurn = turnChanged.signal;
      trace.responses = await deps.runSeat({
        seat,
        simulationId: simulationId!,
        configHash,
        playerId,
        mcpUrl: url,
        model: options.model,
        reasoning: options.reasoning,
        prompt: options.instruction,
        ...(resumeId ? { resumeId } : {}),
        abortSignal: signal,
        waitForTurn: async (ms) => {
          // Retain notifications that arrive while this seat checks its MCP status.
          try {
            await sleep(ms, undefined, { signal: AbortSignal.any([observedTurn, signal]) });
          } catch (error) {
            signal.throwIfAborted();
            if (!observedTurn.aborted) throw error;
          } finally {
            observedTurn = turnChanged.signal;
          }
        },
        onEvent: (event) => {
          if (event.event === 'finished') {
            turnChanged.abort();
            turnChanged = new AbortController();
            observedTurn = turnChanged.signal;
          }
          if (event.response) {
            const index = trace.responses.findIndex(({ id }) => id === event.response!.id);
            if (index < 0) trace.responses.push(event.response);
            else trace.responses[index] = event.response;
          }
          if (event.error !== undefined) trace.errors.push(event);
        },
        status: async (signal) => {
          let response: McpResponse;
          try {
            response = await client.callTool({
              name: 'get_actions',
              options: { ...(signal ? { signal } : {}), timeout: 5_000, maxTotalTimeout: 15_000 },
            });
            trace.mcpCalls.push({ name: 'get_actions', response });
          } catch (error) {
            trace.mcpCalls.push({ name: 'get_actions', error: errorDetails(error) });
            if (
              !signal?.aborted &&
              error instanceof Error &&
              error.name === 'MCPClientError' &&
              (!('code' in error) || error.code == null) &&
              /^Request timed out after \d+ms$/.test(error.message)
            )
              return { state: 'waiting', retry_after_ms: 1_000 };
            throw error;
          }
          const body = response.structuredContent as Record<string, any> | undefined;
          if (response.isError && body?.error?.code === 'BUSY')
            return { state: 'waiting', retry_after_ms: body.retry_after_ms };
          const { actions, retry_after_ms } = payload(response);
          return {
            state: actions.length ? 'action_required' : retry_after_ms ? 'waiting' : 'complete',
            retry_after_ms,
          };
        },
      });
    });
    await Promise.all(runs).catch(async (error) => {
      abort.abort(error);
      await Promise.allSettled(runs);
      throw error;
    });
    const terminal = await operatorCall('get_simulation', { simulation_id: simulationId }, signal);
    if (terminal.ok !== true || terminal.status !== 'completed' || terminal.stage !== 'complete')
      throw new Error('Responses seats returned before the tournament completed.');
  } catch (error) {
    failure = error;
    harness.status =
      signal.reason === timeoutError
        ? 'timed_out'
        : options.abortSignal?.aborted
          ? 'interrupted'
          : 'failed';
    harness.error = errorDetails(error);
    if (signal.aborted) harness.abort_reason = errorDetails(signal.reason);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  let arena: Record<string, any> | null = null;
  if (operator && simulationId) {
    try {
      // Players have stopped. Preserve the canonical game state even after play was aborted.
      arena = await operatorCall('export_simulation', { simulation_id: simulationId });
      if (!arena.result || typeof arena.result !== 'object')
        throw new Error('Arena export omitted its result.');
    } catch (error) {
      harness.export_error = errorDetails(error);
      if (harness.status === 'completed') {
        failure = error;
        harness.status = 'failed';
        harness.error = errorDetails(error);
      }
    }
  }
  const closed = await Promise.allSettled(clients.map((client) => client.close()));
  const closeErrors = closed
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (closeErrors.length) {
    harness.cleanup_errors = closeErrors.map(errorDetails);
    if (harness.status === 'completed') {
      failure = closeErrors[0];
      harness.status = 'failed';
      harness.error = errorDetails(failure);
    }
  }
  const result: unknown = arena?.result ?? null;
  const output: TrialOutput = {
    result,
    arena,
    harness,
    trajectory: buildAtif({
      trialId: options.trialId,
      sessionName: options.sessionName,
      simulationId,
      model: options.model,
      reasoning: options.reasoning,
      prompt: options.instruction,
      seats: traces,
      result,
      harness,
      operatorCalls,
      resumeEvents,
    }),
  };
  if (harness.status !== 'completed') throw new TrialFailure(failure, output);
  return output;
}
