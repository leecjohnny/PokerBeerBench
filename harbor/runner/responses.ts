import OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorDetails, type ReasoningLevel } from './atif.ts';
export const ARENA_TOOL_NAMES = Object.freeze(
  'get_rules,get_status,get_actions,submit_action,read_inbox,send_message'.split(','),
);
const arenaServerLabel = 'arena_cursor';
export type ResponseApi = {
  create(
    body: ResponseCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<OpenAIResponse>;
  retrieve(id: string, query?: object, options?: { signal?: AbortSignal }): Promise<OpenAIResponse>;
  cancel(id: string): Promise<OpenAIResponse>;
};
type PlayerStatus = { state?: string; retry_after_ms?: number };
export type ResponseEvent = {
  event: 'created' | 'retrieved' | 'finished' | 'cancelled' | 'error';
  response_id?: string;
  response?: OpenAIResponse;
  request_id?: string | null;
  request?: ResponseCreateParamsNonStreaming;
  operation?: string;
  error?: unknown;
};
type Observe = (event: ResponseEvent) => void | Promise<void>;
function responseEvent(event: ResponseEvent['event'], response: OpenAIResponse): ResponseEvent {
  const requestId = (response as OpenAIResponse & { _request_id?: string | null })._request_id;
  return {
    event,
    response_id: response.id,
    response,
    ...(requestId !== undefined ? { request_id: requestId } : {}),
  };
}
export type ResponsesSeatInput = {
  seat: number;
  simulationId: string;
  configHash: string;
  playerId: string;
  mcpUrl: string;
  model: string;
  reasoning: ReasoningLevel;
  prompt: string;
  resumeId?: string;
  status(signal?: AbortSignal): Promise<PlayerStatus>;
  waitForTurn?: Wait;
  abortSignal?: AbortSignal;
  onEvent?: Observe;
};
export type ResponseSeat = {
  simulationId: string;
  configHash: string;
  playerId: string;
  url: string;
  resumeId: string;
};
type Wait = (ms: number, signal?: AbortSignal) => Promise<unknown>;
const defaultWait: Wait = (ms, signal) => sleep(ms, undefined, { signal });
class QueueDeadlineError extends Error {}
async function terminal(
  api: ResponseApi,
  response: string | OpenAIResponse,
  signal?: AbortSignal,
  wait: Wait = defaultWait,
  observe?: Observe,
) {
  const queueDeadline = Date.now() + 900_000;
  const retrieve = async (id: string) => {
    const value = await api.retrieve(id, undefined, signal ? { signal } : undefined);
    await observe?.(responseEvent('retrieved', value));
    return value;
  };
  let current = typeof response === 'string' ? await retrieve(response) : response;
  while (current.status === 'queued' || current.status === 'in_progress') {
    if ((current.status === 'queued' || !current.output.length) && Date.now() >= queueDeadline)
      throw new QueueDeadlineError('Response queue deadline exceeded.');
    await wait(1_000, signal);
    current = await retrieve(current.id);
  }
  return current;
}
async function completed(
  api: ResponseApi,
  response: string | OpenAIResponse,
  signal?: AbortSignal,
  wait?: Wait,
  observe?: Observe,
) {
  const current = await terminal(api, response, signal, wait, observe);
  if (current.status !== 'completed')
    throw new Error(`Response ${current.id} ended ${current.status}.`);
  return current;
}
async function history(api: ResponseApi, cursor: string, signal?: AbortSignal, observe?: Observe) {
  const responses: OpenAIResponse[] = [];
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error('Response history contains a cycle.');
    seen.add(cursor);
    const response = await completed(api, cursor, signal, undefined, observe);
    responses.unshift(response);
    cursor = response.previous_response_id ?? '';
  }
  return responses;
}
export const hasExactArenaTools = (tools: unknown) =>
  Array.isArray(tools) &&
  tools.length === ARENA_TOOL_NAMES.length &&
  ARENA_TOOL_NAMES.every((name) => tools.includes(name));
export function isTrustedSeatUrl(operator: URL, url: URL): boolean {
  const prefix = operator.pathname.slice(0, operator.pathname.lastIndexOf('/') + 1);
  return (
    url.origin === operator.origin &&
    url.pathname.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{32,}$/.test(url.pathname.slice(prefix.length)) &&
    !url.search &&
    !url.hash
  );
}
export async function resolveResponseSeats(
  ids: string[],
  model: string,
  reasoning: ReasoningLevel,
  arenaMcpUrl: string,
  players: string[],
  api: ResponseApi = new OpenAI().responses,
  signal?: AbortSignal,
  observe?: Observe,
): Promise<ResponseSeat[]> {
  if (ids.length !== 8 || ids.some((id) => !id.trim()))
    throw new Error('Resume requires eight nonempty Response IDs.');
  const operator = new URL(arenaMcpUrl);
  const abort = new AbortController();
  const preflightSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const pending = ids.map(async (resumeId) => {
    try {
      const response = await completed(api, resumeId, preflightSignal, undefined, observe);
      const tool = response.tools.find((item) => item.type === 'mcp');
      const simulationId = response.metadata?.simulation_id;
      const configHash = response.metadata?.config_hash;
      const playerId = response.metadata?.player_id;
      if (
        response.model !== model ||
        response.reasoning?.effort !== reasoning ||
        typeof simulationId !== 'string' ||
        typeof configHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(configHash) ||
        typeof playerId !== 'string' ||
        !tool ||
        !['arena', arenaServerLabel].includes(tool.server_label) ||
        typeof tool.server_url !== 'string' ||
        !hasExactArenaTools(tool.allowed_tools) ||
        tool.require_approval !== 'never'
      )
        throw new Error('Response cursor does not match this benchmark.');
      const url = new URL(tool.server_url);
      if (!isTrustedSeatUrl(operator, url))
        throw new Error('Response cursor contains an untrusted Arena endpoint.');
      return { simulationId, configHash, playerId, url: url.href, resumeId };
    } catch (error) {
      await observe?.({
        event: 'error',
        operation: 'resume',
        response_id: resumeId,
        error: errorDetails(error),
      });
      throw error;
    }
  });
  const seats = await Promise.all(pending).catch(async (error) => {
    abort.abort(error);
    await Promise.allSettled(pending);
    throw error;
  });
  const expectedPlayers = [...players].sort();
  if (
    seats.length !== 8 ||
    new Set(seats.map((seat) => seat.simulationId)).size !== 1 ||
    new Set(seats.map((seat) => seat.configHash)).size !== 1 ||
    new Set(seats.map((seat) => seat.playerId)).size !== 8 ||
    new Set(seats.map((seat) => seat.url)).size !== 8 ||
    seats
      .map((seat) => seat.playerId)
      .sort()
      .some((id, index) => id !== expectedPlayers[index])
  )
    throw new Error('Resume requires eight Responses seats from one simulation and config.');
  return seats;
}
async function journal(input: ResponsesSeatInput, event: ResponseEvent): Promise<void> {
  await input.onEvent?.(event);
  const dir = process.env.RESPONSES_EVENT_LOG_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const identity = {
    seat: input.seat,
    player_id: input.playerId,
    simulation_id: input.simulationId,
    config_hash: input.configHash,
  };
  await appendFile(
    join(dir, `seat-${input.seat}.jsonl`),
    `${JSON.stringify({ ...identity, ...event })}\n`,
  );
  if (!event.response_id || !['created', 'finished', 'cancelled'].includes(event.event)) return;
  const target = join(dir, `seat-${input.seat}.cursor.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...identity, response_id: event.response_id })}\n`,
  );
  await rename(temporary, target);
}
export async function runResponsesSeat(
  input: ResponsesSeatInput,
  api: ResponseApi = new OpenAI().responses,
  wait: Wait = defaultWait,
): Promise<OpenAIResponse[]> {
  if (!Number.isInteger(input.seat) || input.seat < 1 || input.seat > 8)
    throw new Error('A Responses seat must be numbered 1 through 8.');
  let inflight: string | undefined;
  let cursor = input.resumeId;
  let responseId = cursor;
  let retries = 0;
  const responses: OpenAIResponse[] = [];
  const requestOptions = input.abortSignal ? { signal: input.abortSignal } : undefined;
  let operation = 'status';
  let request: ResponseCreateParamsNonStreaming | undefined;
  let failure: unknown;
  const combine = (error: unknown, message: string) => {
    if (failure === undefined) return error;
    failure = new AggregateError([failure, error], message, { cause: failure });
    return failure;
  };
  const observe: Observe = (event) =>
    journal(input, event).catch((error) => {
      throw combine(error, 'Response execution and evidence writing failed.');
    });
  const report = (error: unknown, errorOperation = operation) =>
    observe({
      event: 'error',
      operation: errorOperation,
      error: errorDetails(error),
      ...(responseId ? { response_id: responseId } : {}),
      ...(operation === 'create' && request ? { request } : {}),
    });
  const retry = async (error: unknown, retryOperation: string) => {
    if (retries >= 2 || input.abortSignal?.aborted) throw error;
    await report(error, retryOperation);
    await wait(++retries * 1_000, input.abortSignal);
  };
  const call = async (execute: () => Promise<OpenAIResponse>): Promise<OpenAIResponse> => {
    for (;;) {
      try {
        return await execute();
      } catch (error) {
        if (!(error instanceof OpenAI.APIError) || !error.status || error.status < 500) throw error;
        await retry(error, 'request_retry');
      }
    }
  };
  const provider = api;
  api = {
    create: (...args) => call(() => provider.create(...args)),
    retrieve: (...args) => call(() => provider.retrieve(...args)),
    cancel: async (id) => {
      try {
        return await provider.cancel(id);
      } catch (error) {
        if (!(error instanceof OpenAI.APIError) || error.status !== 400) throw error;
        const current = await provider.retrieve(id);
        if (!['completed', 'cancelled', 'failed', 'incomplete'].includes(current.status ?? ''))
          throw error;
        return current;
      }
    },
  };
  const initialSystemMessage = `You are ${input.playerId}. Your biography is your background; your private goals are what you want.
${input.prompt}

Before acting, privately consider: What matters to me here? What do I know, and what am I assuming? How does this person's offer serve or conflict with my interests?
Speak from that perspective. Respond to the person and the moment, remembering your previous exchanges. Use language you would plausibly use with them. Let your character emerge through your choices, without explaining your persona or narrating this reflection.

The Arena MCP identifies your seat. Begin by calling \`get_rules\` once, then call \`get_status\`. Pass after_cursor: null for a full snapshot; on later turns, use the last returned next_cursor. While has_more is true, call get_status again with next_cursor before choosing your action. Use null again if you need a full refresh.
If action_required, read unread messages and send any appropriate messages before calling get_actions and submitting exactly one legal action with submit_action. Sending is allowed only when can_send_message is true. Messaging is separate from the one submit_action limit. After submitting, end this response.
If waiting or complete, end immediately. Never poll repeatedly in one response.`;
  const ready = async () => {
    operation = 'status';
    let status = await input.status(input.abortSignal);
    while (status.state === 'waiting') {
      await (input.waitForTurn ?? wait)(status.retry_after_ms ?? 1_000, input.abortSignal);
      status = await input.status(input.abortSignal);
    }
    if (status.state === 'complete') return false;
    if (status.state !== 'action_required')
      throw new Error(`Arena returned invalid player state ${status.state}.`);
    return true;
  };
  const evidence = async () => {
    operation = 'history';
    return input.resumeId
      ? [...(await history(api, input.resumeId, input.abortSignal, observe)), ...responses]
      : responses;
  };
  try {
    if (cursor && !(await ready())) return await evidence();
    for (;;) {
      operation = 'create';
      request = {
        model: input.model,
        reasoning: { effort: input.reasoning, summary: 'auto' },
        background: true,
        store: true,
        parallel_tool_calls: false,
        max_output_tokens: 8_192,
        context_management: [{ type: 'compaction', compact_threshold: 244_800 }],
        input: cursor
          ? 'It is your turn. Call get_status for the current state, then follow the turn procedure.'
          : [{ role: 'system', content: initialSystemMessage }],
        metadata: {
          simulation_id: input.simulationId,
          config_hash: input.configHash,
          player_id: input.playerId,
        },
        ...(cursor ? { previous_response_id: cursor } : {}),
        tools: [
          {
            type: 'mcp',
            server_label: arenaServerLabel,
            server_url: input.mcpUrl,
            allowed_tools: [...ARENA_TOOL_NAMES],
            require_approval: 'never',
          },
        ],
      };
      responseId = undefined;
      const created = await api.create(request, requestOptions);
      inflight = created.id;
      responseId = created.id;
      await observe({
        ...responseEvent('created', created),
        request,
      });
      operation = 'retrieve';
      let response: OpenAIResponse;
      let queueError: QueueDeadlineError | undefined;
      try {
        response = await terminal(api, created, input.abortSignal, wait, observe);
      } catch (error) {
        if (!(error instanceof QueueDeadlineError) || input.abortSignal?.aborted) throw error;
        queueError = error;
        operation = 'cancel';
        response = await api.cancel(created.id);
        inflight = undefined;
        await observe(responseEvent('cancelled', response));
      }
      inflight = undefined;
      await observe(responseEvent('finished', response));
      responses.push(response);
      const noTools =
        response.status === 'completed' &&
        !response.output.some((item) => item.type === 'mcp_call') &&
        (await input.status(input.abortSignal)).state === 'action_required';
      if (response.status !== 'completed' || noTools) {
        const reason = noTools ? 'without MCP calls while action required' : response.status;
        const error = queueError ?? new Error(`Response ${response.id} ended ${reason}.`);
        const retryable =
          noTools ||
          (queueError && response.status === 'cancelled' && response.output.length === 0) ||
          (response.status === 'failed' && response.error?.code === 'server_error') ||
          (response.status === 'incomplete' &&
            response.incomplete_details?.reason === 'max_output_tokens');
        if (!retryable) throw error;
        await retry(error, queueError ? 'queue_retry' : 'response_retry');
        if (await ready()) continue;
        return await evidence();
      }
      cursor = response.id;
      retries = 0;
      if (!(await ready())) return await evidence();
    }
  } catch (error) {
    failure = error;
    await report(error);
    throw error;
  } finally {
    if (inflight) {
      let response: OpenAIResponse;
      try {
        response = await api.cancel(inflight);
      } catch (error) {
        const combined = combine(error, 'Response execution and cancellation failed.');
        await report(error, 'cancel');
        throw combined;
      }
      await observe(responseEvent('cancelled', response));
    }
  }
}
