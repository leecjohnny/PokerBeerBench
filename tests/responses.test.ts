import type { Response } from 'openai/resources/responses/responses';
import OpenAI from 'openai';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARENA_TOOL_NAMES,
  hasExactArenaTools,
  resolveResponseSeats,
  runResponsesSeat,
  type ResponseApi,
  type ResponseEvent,
} from '../harbor/runner/responses.ts';
import { buildAtif } from '../harbor/runner/atif.ts';
const mcpUrl = 'https://arena.test/mcp/seat-capability-0000000000000000';
const configHash = 'c'.repeat(64);
const turnPrompt =
  'It is your turn. Call get_status for the current state, then follow the turn procedure.';
const events: ResponseEvent[] = [];
beforeEach(() => {
  events.length = 0;
});
function recordEvent(event: ResponseEvent) {
  events.push(event);
}
const mockApi = (overrides: Partial<ResponseApi> = {}): ResponseApi => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
  ...overrides,
});
const httpError = (status: number) =>
  new OpenAI.APIError(status, { code: 'server_error' }, 'provider failure', new Headers());
const output = (id: string, name = 'get_status') =>
  [
    {
      type: 'mcp_call',
      id: `call-${id}`,
      name,
      server_label: 'arena',
      arguments: '{}',
      output: '{"ok":true}',
      status: 'completed',
    },
  ] as Response['output'];
const rejected = (id: string) =>
  [
    {
      type: 'mcp_call',
      id: `call-${id}`,
      name: 'submit_action',
      server_label: 'arena',
      arguments: '{}',
      error: { type: 'mcp_tool_execution_error', content: [] },
    },
  ] as unknown as Response['output'];
function response(
  id: string,
  status: Response['status'],
  items = output(id),
  playerId = 'player-1',
  serverUrl = mcpUrl,
  serverLabel = 'arena',
): Response {
  return {
    id,
    status,
    output: items,
    output_text: '',
    model: 'gpt-5.6-luna',
    created_at: 1,
    completed_at: status === 'completed' ? 2 : null,
    previous_response_id: id === 'response-2' ? 'response-1' : null,
    metadata: { simulation_id: 'simulation-1', config_hash: configHash, player_id: playerId },
    reasoning: { effort: 'medium', summary: null },
    tools: [
      {
        type: 'mcp',
        server_label: serverLabel,
        server_url: serverUrl,
        allowed_tools: ARENA_TOOL_NAMES,
        require_approval: 'never',
      },
    ],
    usage:
      status === 'completed'
        ? {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens_details: { reasoning_tokens: 1 },
          }
        : null,
  } as unknown as Response;
}
function input(states: string[]) {
  return {
    seat: 1,
    simulationId: 'simulation-1',
    configHash,
    playerId: 'player-1',
    mcpUrl,
    model: 'gpt-5.6-luna',
    reasoning: 'medium' as const,
    prompt: 'Play.',
    status: async () => ({ state: states.shift()!, retry_after_ms: 30_000 }),
    onEvent: recordEvent,
  };
}
function interrupted(id: string, reason: 'server_error' | 'max_output_tokens'): Response {
  const partial = output(id, 'send_message');
  Object.assign(partial[0]!, { status: 'in_progress', output: null });
  return reason === 'server_error'
    ? { ...response(id, 'failed', partial), error: { code: reason, message: 'provider failure' } }
    : { ...response(id, 'incomplete', partial), incomplete_details: { reason } };
}
const noToolOutputs: Array<{ label: string; items: Response['output'] }> = [
  { label: 'empty', items: [] },
  {
    label: 'text-only',
    items: [
      {
        type: 'message',
        id: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'I am waiting.', annotations: [], logprobs: [] }],
      },
    ],
  },
];
describe('Responses runner', () => {
  it('requires exactly the six Arena tool names, in any order', () => {
    expect(hasExactArenaTools([...ARENA_TOOL_NAMES].reverse())).toBe(true);
    for (const tools of [
      null,
      [],
      ARENA_TOOL_NAMES.slice(1),
      [...ARENA_TOOL_NAMES, 'extra'],
      [...ARENA_TOOL_NAMES.slice(1), ARENA_TOOL_NAMES[1]],
      [...ARENA_TOOL_NAMES.slice(1), 1],
    ])
      expect(hasExactArenaTools(tools)).toBe(false);
  });
  it.each(noToolOutputs)(
    'retries $label completions without advancing the cursor',
    async ({ items }) => {
      for (const resumeId of [undefined, 'saved']) {
        events.length = 0;
        const attempt = response('attempt', 'completed', items);
        const api = mockApi({
          create: vi
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValue(response('done', 'completed')),
          retrieve: vi.fn(async (id) => response(id, 'completed')),
        });
        const wait = vi.fn(async () => undefined);
        const result = await runResponsesSeat(
          {
            ...input([]),
            ...(resumeId ? { resumeId } : {}),
            status: async () => ({
              state: vi.mocked(api.create).mock.calls.length < 2 ? 'action_required' : 'complete',
            }),
          },
          api,
          wait,
        );
        expect(result.map(({ id }) => id)).toEqual([
          ...(resumeId ? ['saved'] : []),
          'attempt',
          'done',
        ]);
        expect(wait).toHaveBeenCalledExactlyOnceWith(1_000, undefined);
        const bodies = vi.mocked(api.create).mock.calls.map(([body]) => body);
        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[1]!.previous_response_id).toBe(resumeId);
        expect(bodies[1]!.input).toEqual(
          resumeId ? turnPrompt : [{ role: 'system', content: expect.any(String) }],
        );
        expect(events).toContainEqual(
          expect.objectContaining({ event: 'finished', response: attempt }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ event: 'error', operation: 'response_retry' }),
        );
        expect(api.cancel).not.toHaveBeenCalled();
      }
    },
  );
  it.each(noToolOutputs)(
    'bounds $label retries, including a mixed provider failure',
    async ({ items }) => {
      for (const mixed of [false, true]) {
        events.length = 0;
        const attempt = response('attempt', 'completed', items);
        const api = mockApi({
          create: vi
            .fn()
            .mockResolvedValueOnce(attempt)
            .mockResolvedValueOnce(mixed ? interrupted('failed', 'server_error') : attempt)
            .mockResolvedValue(attempt),
        });
        const wait = vi.fn(async (_ms: number) => undefined);
        await expect(
          runResponsesSeat(
            { ...input([]), status: async () => ({ state: 'action_required' }) },
            api,
            wait,
          ),
        ).rejects.toThrow('ended without MCP calls while action required');
        expect(api.create).toHaveBeenCalledTimes(3);
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
        expect(events.filter(({ event }) => event === 'finished')).toHaveLength(3);
        expect(events.filter(({ operation }) => operation === 'response_retry')).toHaveLength(2);
        expect(
          vi
            .mocked(api.create)
            .mock.calls.every(([body]) => body.previous_response_id === undefined),
        ).toBe(true);
        expect(api.cancel).not.toHaveBeenCalled();
      }
    },
  );
  it.each(['waiting', 'complete'])(
    'accepts a no-tool completion when the Arena is %s',
    async (state) => {
      const api = mockApi({
        create: vi
          .fn()
          .mockResolvedValueOnce(response('waiting', 'completed', []))
          .mockResolvedValue(response('done', 'completed')),
      });
      const waitForTurn = vi.fn(async () => undefined);
      const wait = vi.fn(async () => undefined);
      const result = await runResponsesSeat(
        {
          ...input(
            state === 'waiting'
              ? ['waiting', 'waiting', 'action_required', 'complete']
              : ['complete', 'complete'],
          ),
          waitForTurn,
        },
        api,
        wait,
      );
      expect(result.map(({ id }) => id)).toEqual(
        state === 'waiting' ? ['waiting', 'done'] : ['waiting'],
      );
      expect(events.filter(({ event }) => event === 'error')).toEqual([]);
      expect(wait).not.toHaveBeenCalled();
      if (state === 'waiting') {
        expect(waitForTurn).toHaveBeenCalledExactlyOnceWith(30_000, undefined);
        expect(vi.mocked(api.create).mock.calls[1]![0]).toMatchObject({
          previous_response_id: 'waiting',
          input: turnPrompt,
        });
      }
    },
  );
  it.each(
    ['queued', 'in_progress'].flatMap((status) =>
      ['startup', 'recover', 'exhaust', 'completed_race', 'partial', 'cancel_failure'].map(
        (scenario) => ({ status: status as Response['status'], scenario }),
      ),
    ),
  )('handles a $status deadline safely: $scenario', async ({ status, scenario }) => {
    let now = 0;
    let cancelled = false;
    const recovering = scenario === 'recover' || scenario === 'startup';
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const api = mockApi({
      create: vi.fn(async () => response('attempt', status, [])),
      retrieve: vi.fn(async (id) =>
        response(
          id,
          id === 'saved' || id === 'done' || (cancelled && scenario === 'completed_race')
            ? 'completed'
            : status,
          [],
        ),
      ),
      cancel: vi.fn(async () => {
        if (scenario === 'cancel_failure') throw new Error('cancel unavailable');
        cancelled = true;
        return response(
          'attempt',
          scenario === 'completed_race' ? 'completed' : 'cancelled',
          scenario === 'partial' || scenario === 'completed_race' ? output('partial') : [],
        );
      }),
    });
    if (recovering)
      vi.mocked(api.create)
        .mockResolvedValueOnce(response('attempt', status, []))
        .mockResolvedValue(response('done', 'completed'));
    try {
      const states =
        scenario === 'completed_race' || scenario === 'startup'
          ? ['action_required', 'complete']
          : scenario === 'recover'
            ? ['action_required', 'action_required', 'complete']
            : ['action_required', 'action_required', 'action_required'];
      const run = runResponsesSeat(
        {
          ...input(states),
          ...(scenario === 'startup' ? {} : { resumeId: 'saved' }),
        },
        api,
        async () => {
          now += 900_000;
        },
      );
      if (recovering || scenario === 'completed_race') {
        expect((await run).map(({ id }) => id)).toEqual([
          ...(scenario === 'startup' ? [] : ['saved']),
          'attempt',
          ...(recovering ? ['done'] : []),
        ]);
      } else
        await expect(run).rejects.toThrow(
          scenario === 'cancel_failure' ? 'failed' : 'queue deadline',
        );
      if (scenario === 'exhaust') expect(api.create).toHaveBeenCalledTimes(3);
      if (scenario === 'partial' || scenario === 'cancel_failure')
        expect(api.create).toHaveBeenCalledTimes(1);
      if (scenario === 'completed_race') expect(api.create).toHaveBeenCalledTimes(1);
      if (recovering) expect(api.create).toHaveBeenCalledTimes(2);
      for (const [body] of vi.mocked(api.create).mock.calls) {
        expect(body).toEqual(vi.mocked(api.create).mock.calls[0]![0]);
        expect(body.previous_response_id).toBe(scenario === 'startup' ? undefined : 'saved');
        expect(body.input).toEqual(
          scenario === 'startup' ? [{ role: 'system', content: expect.any(String) }] : turnPrompt,
        );
        expect(body).not.toHaveProperty('instructions');
        expect(body.tools).toEqual([expect.objectContaining({ server_label: 'arena_cursor' })]);
      }
      expect(events.some((event) => event.event === 'cancelled')).toBe(
        scenario !== 'cancel_failure',
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('does not cancel in-progress work with output at the empty-response deadline', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const api = mockApi({
      create: vi.fn(async () => response('attempt', 'in_progress')),
      retrieve: vi
        .fn()
        .mockResolvedValueOnce(response('attempt', 'in_progress'))
        .mockResolvedValue(response('attempt', 'completed')),
    });
    try {
      await runResponsesSeat(input(['complete']), api, async () => {
        now += 900_000;
      });
      expect(api.retrieve).toHaveBeenCalledTimes(2);
      expect(api.cancel).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('reconciles a deadline cancellation conflict and uses the completed Response as its cursor', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const raced = response('attempt', 'completed', output('attempt', 'submit_action'));
    const api = mockApi({
      create: vi
        .fn()
        .mockResolvedValueOnce(response('attempt', 'in_progress', []))
        .mockResolvedValue(response('done', 'completed')),
      retrieve: vi
        .fn()
        .mockResolvedValueOnce(response('attempt', 'in_progress', []))
        .mockResolvedValue(raced),
      cancel: vi.fn().mockRejectedValue(httpError(400)),
    });
    try {
      expect(
        await runResponsesSeat(input(['action_required', 'complete']), api, async () => {
          now += 900_000;
        }),
      ).toEqual([raced, response('done', 'completed')]);
      expect(vi.mocked(api.create).mock.calls[1]![0].previous_response_id).toBe('attempt');
      expect(api.cancel).toHaveBeenCalledExactlyOnceWith('attempt');
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'finished', response: raced }),
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('does not reset the empty deadline or retry budget when retrieval recovers', async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const api = mockApi({
      create: vi
        .fn()
        .mockResolvedValueOnce(response('attempt', 'in_progress', []))
        .mockResolvedValue(response('done', 'completed')),
      retrieve: vi
        .fn()
        .mockRejectedValueOnce(httpError(500))
        .mockResolvedValueOnce(response('attempt', 'in_progress', []))
        .mockResolvedValue(response('attempt', 'completed')),
      cancel: vi.fn(async (id) => response(id, 'cancelled', [])),
    });
    const wait = vi.fn(async (_ms: number) => {
      now += 450_000;
    });
    try {
      await runResponsesSeat(
        {
          ...input([]),
          status: async () => ({
            state: vi.mocked(api.create).mock.calls.length < 2 ? 'action_required' : 'complete',
          }),
        },
        api,
        wait,
      );
      expect(api.retrieve).toHaveBeenCalledTimes(2);
      expect(api.cancel).toHaveBeenCalledExactlyOnceWith('attempt');
      expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1_000, 1_000, 2_000]);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['completed', 'cancelled', 'failed', 'incomplete'] as const)(
    'reconciles cleanup cancellation conflicts with terminal %s evidence, including after abort',
    async (status) => {
      const dir = await mkdtemp(join(tmpdir(), 'pokerbeer-cancel-race-'));
      process.env.RESPONSES_EVENT_LOG_DIR = dir;
      const original = new Error('poll aborted');
      const abort = new AbortController();
      const terminal = response('attempt', status, output('attempt', 'submit_action'));
      const api = mockApi({
        create: vi.fn(async () => response('attempt', 'in_progress', [])),
        retrieve: vi
          .fn()
          .mockImplementationOnce(async () => {
            abort.abort(original);
            throw original;
          })
          .mockResolvedValue(terminal),
        cancel: vi.fn().mockRejectedValue(httpError(400)),
      });
      try {
        await expect(
          runResponsesSeat({ ...input([]), abortSignal: abort.signal }, api, async () => undefined),
        ).rejects.toBe(original);
        expect(api.create).toHaveBeenCalledOnce();
        expect(api.cancel).toHaveBeenCalledExactlyOnceWith('attempt');
        expect(vi.mocked(api.retrieve).mock.calls[1]![0]).toBe('attempt');
        expect(vi.mocked(api.retrieve).mock.calls[1]![2]?.signal?.aborted).not.toBe(true);
        expect(events).toContainEqual(
          expect.objectContaining({ event: 'cancelled', response: terminal }),
        );
        expect(
          JSON.parse(await readFile(join(dir, 'seat-1.cursor.json'), 'utf8')).response_id,
        ).toBe('attempt');
      } finally {
        delete process.env.RESPONSES_EVENT_LOG_DIR;
        await rm(dir, { recursive: true });
      }
    },
  );
  it.each(['queued', 'in_progress', 'get_failure'])(
    'fails closed when cancellation reconciliation remains %s',
    async (status) => {
      const original = new Error('poll failed');
      const retrieve = vi.fn().mockRejectedValueOnce(original);
      if (status === 'get_failure') retrieve.mockRejectedValue(new Error('reconciliation failed'));
      else retrieve.mockResolvedValue(response('attempt', status as Response['status'], []));
      const api = mockApi({
        create: vi.fn(async () => response('attempt', 'in_progress', [])),
        retrieve,
        cancel: vi.fn().mockRejectedValue(httpError(400)),
      });
      const failure = await runResponsesSeat(input([]), api, async () => undefined).catch(
        (error) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0]).toBe(original);
      expect(api.create).toHaveBeenCalledOnce();
      expect(api.cancel).toHaveBeenCalledOnce();
      expect(events.some(({ event }) => event === 'cancelled')).toBe(false);
    },
  );
  it.each([
    ['server_error', undefined],
    ['server_error', 'saved'],
    ['max_output_tokens', undefined],
    ['max_output_tokens', 'saved'],
  ] as const)(
    'retries partial %s from completed cursor %s without dropping trace evidence',
    async (reason, resumeId) => {
      const attempt = interrupted('attempt', reason);
      const api = mockApi({
        create: vi
          .fn()
          .mockResolvedValueOnce(attempt)
          .mockResolvedValue(response('done', 'completed')),
        retrieve: vi.fn(async (id) => response(id, 'completed')),
      });
      const wait = vi.fn(async () => undefined);
      const result = await runResponsesSeat(
        {
          ...input([...(resumeId ? ['action_required'] : []), 'action_required', 'complete']),
          ...(resumeId ? { resumeId } : {}),
        },
        api,
        wait,
      );
      expect(result.map(({ id }) => id)).toEqual([
        ...(resumeId ? ['saved'] : []),
        'attempt',
        'done',
      ]);
      expect(api.cancel).not.toHaveBeenCalled();
      expect(wait).toHaveBeenCalledExactlyOnceWith(1_000, undefined);
      const bodies = vi.mocked(api.create).mock.calls.map(([body]) => body);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[1]!.previous_response_id).toBe(resumeId);
      expect(bodies[1]!.input).toEqual(
        resumeId ? turnPrompt : [{ role: 'system', content: expect.any(String) }],
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'finished', response: attempt }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'error', operation: 'response_retry' }),
      );
      const atif = buildAtif({
        trialId: 'trial',
        sessionName: 'session',
        simulationId: 'simulation-1',
        model: 'gpt-5.6-luna',
        reasoning: 'medium',
        prompt: 'Play.',
        result: null,
        harness: { status: 'completed' },
        seats: [{ playerId: 'player-1', sessionId: 'done', responses: result }],
      });
      expect(atif.subagent_trajectories[0]!.steps.map((step) => step.extra.response)).toEqual(
        result,
      );
    },
  );
  it.each(['server_error', 'max_output_tokens'] as const)(
    'bounds repeated %s retries and respects terminal Arena state and abort',
    async (reason) => {
      for (const stop of ['exhausted', 'complete', 'aborted']) {
        events.length = 0;
        const api = mockApi({
          create: vi.fn(async () => interrupted('attempt', reason)),
        });
        const wait = vi.fn(async (_ms: number) => undefined);
        const run = runResponsesSeat(
          {
            ...input(stop === 'complete' ? ['complete'] : ['action_required', 'action_required']),
            ...(stop === 'aborted' ? { abortSignal: AbortSignal.abort() } : {}),
          },
          api,
          wait,
        );
        if (stop === 'complete') expect((await run).map(({ id }) => id)).toEqual(['attempt']);
        else await expect(run).rejects.toThrow('Response attempt ended');
        expect(api.create).toHaveBeenCalledTimes(stop === 'exhausted' ? 3 : 1);
        expect(wait.mock.calls.map(([ms]) => ms)).toEqual(
          stop === 'exhausted' ? [1_000, 2_000] : stop === 'complete' ? [1_000] : [],
        );
        expect(events.filter(({ event }) => event === 'finished')).toHaveLength(
          stop === 'exhausted' ? 3 : 1,
        );
        expect(api.cancel).not.toHaveBeenCalled();
      }
    },
  );
  it('shares the retry budget across terminal errors and resets only after completion', async () => {
    const attempts = [
      response('first', 'completed'),
      interrupted('failed', 'server_error'),
      response('empty', 'completed', []),
      response('recovered', 'completed'),
      interrupted('incomplete', 'max_output_tokens'),
      response('done', 'completed'),
    ];
    const remaining = [...attempts];
    const api = mockApi({ create: vi.fn(async () => remaining.shift()!) });
    const wait = vi.fn(async (_ms: number) => undefined);
    const result = await runResponsesSeat(
      {
        ...input([]),
        status: async () => ({ state: remaining.length ? 'action_required' : 'complete' }),
      },
      api,
      wait,
    );
    expect(result).toEqual(attempts);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 1_000]);
    expect(vi.mocked(api.create).mock.calls.map(([body]) => body.previous_response_id)).toEqual([
      undefined,
      'first',
      'first',
      'first',
      'recovered',
      'recovered',
    ]);
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it.each([500, 503, 504])(
    'retries a thrown HTTP %s create error from the same completed cursor',
    async (status) => {
      for (const resumeId of [undefined, 'saved']) {
        events.length = 0;
        const api = mockApi({
          create: vi
            .fn()
            .mockRejectedValueOnce(httpError(status))
            .mockResolvedValue(response('done', 'completed')),
          retrieve: vi.fn(async (id) => response(id, 'completed')),
        });
        const wait = vi.fn(async () => undefined);
        const result = await runResponsesSeat(
          {
            ...input([]),
            ...(resumeId ? { resumeId } : {}),
            status: async () => ({
              state: vi.mocked(api.create).mock.calls.length < 2 ? 'action_required' : 'complete',
            }),
          },
          api,
          wait,
        );
        expect(result.map(({ id }) => id)).toEqual([...(resumeId ? ['saved'] : []), 'done']);
        expect(api.create).toHaveBeenCalledTimes(2);
        expect(vi.mocked(api.create).mock.calls[1]![0]).toEqual(
          vi.mocked(api.create).mock.calls[0]![0],
        );
        expect(vi.mocked(api.create).mock.calls[1]![0].previous_response_id).toBe(resumeId);
        expect(wait).toHaveBeenCalledExactlyOnceWith(1_000, undefined);
        expect(events).toContainEqual(
          expect.objectContaining({ event: 'error', error: expect.objectContaining({ status }) }),
        );
        expect(api.cancel).not.toHaveBeenCalled();
      }
    },
  );
  it('retries retrieval of the same in-flight Response without starting another chain', async () => {
    const api = mockApi({
      create: vi.fn(async () => response('attempt', 'in_progress', [])),
      retrieve: vi
        .fn()
        .mockRejectedValueOnce(httpError(500))
        .mockRejectedValueOnce(httpError(503))
        .mockResolvedValue(response('attempt', 'completed')),
    });
    const result = await runResponsesSeat(input(['complete']), api, async () => undefined);
    expect(result.map(({ id }) => id)).toEqual(['attempt']);
    expect(api.create).toHaveBeenCalledOnce();
    expect(vi.mocked(api.retrieve).mock.calls.map(([id]) => id)).toEqual([
      'attempt',
      'attempt',
      'attempt',
    ]);
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it.each(['create', 'retrieve'] as const)(
    'shares the two-retry budget between thrown %s errors and terminal failures',
    async (operation) => {
      const last = httpError(503);
      const api = mockApi({
        create:
          operation === 'create'
            ? vi
                .fn()
                .mockRejectedValueOnce(httpError(500))
                .mockResolvedValueOnce(interrupted('attempt', 'server_error'))
                .mockRejectedValue(last)
            : vi
                .fn()
                .mockResolvedValueOnce(response('attempt', 'in_progress', []))
                .mockRejectedValue(last),
        retrieve: vi
          .fn()
          .mockRejectedValueOnce(httpError(500))
          .mockResolvedValue(interrupted('attempt', 'server_error')),
      });
      await expect(
        runResponsesSeat(
          { ...input([]), status: async () => ({ state: 'action_required' }) },
          api,
          async () => undefined,
        ),
      ).rejects.toBe(last);
      expect(api.create).toHaveBeenCalledTimes(operation === 'create' ? 3 : 2);
      expect(api.retrieve).toHaveBeenCalledTimes(operation === 'create' ? 0 : 2);
      expect(api.cancel).not.toHaveBeenCalled();
      expect(events.filter(({ event }) => event === 'finished')).toHaveLength(1);
    },
  );
  it.each([400, 401, 403, 404, 409, 422, 429])(
    'does not add harness retries for permanent HTTP %s create failures',
    async (status) => {
      const failure = httpError(status);
      const api = mockApi({ create: vi.fn().mockRejectedValue(failure) });
      const wait = vi.fn(async () => undefined);
      await expect(runResponsesSeat(input([]), api, wait)).rejects.toBe(failure);
      expect(api.create).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      expect(api.cancel).not.toHaveBeenCalled();
    },
  );
  it('does not retry a thrown server error after abort', async () => {
    const failure = httpError(500);
    const api = mockApi({ create: vi.fn().mockRejectedValue(failure) });
    const wait = vi.fn(async () => undefined);
    await expect(
      runResponsesSeat({ ...input([]), abortSignal: AbortSignal.abort() }, api, wait),
    ).rejects.toBe(failure);
    expect(api.create).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });
  it.each([
    { ...response('attempt', 'failed'), error: { code: 'invalid_prompt', message: 'invalid' } },
    { ...response('attempt', 'failed'), error: null },
    { ...response('attempt', 'incomplete'), incomplete_details: { reason: 'content_filter' } },
    { ...response('attempt', 'incomplete'), incomplete_details: null },
  ] as Response[])(
    'does not retry unrecognized or filtered terminal responses: $status $error $incomplete_details',
    async (attempt) => {
      const api = mockApi({ create: vi.fn(async () => attempt) });
      await expect(runResponsesSeat(input([]), api)).rejects.toThrow(
        `Response attempt ended ${attempt.status}`,
      );
      expect(api.create).toHaveBeenCalledOnce();
      expect(api.cancel).not.toHaveBeenCalled();
    },
  );
  it('uses one stored Response ID cursor and returns every raw completed turn', async () => {
    const api = mockApi({
      create: vi
        .fn()
        .mockResolvedValueOnce(response('response-1', 'queued'))
        .mockResolvedValue(
          response('response-2', 'completed', output('response-2', 'submit_action')),
        ),
      retrieve: vi.fn(async (id) =>
        response(id, 'completed', id === 'response-1' ? rejected(id) : output(id)),
      ),
    });
    const waitForTurn = vi.fn(async () => undefined);
    const poll = vi.fn(async () => undefined);
    const result = await runResponsesSeat(
      { ...input(['waiting', 'action_required', 'complete']), waitForTurn },
      api,
      poll,
    );
    expect(waitForTurn).toHaveBeenCalledExactlyOnceWith(30_000, undefined);
    expect(poll).toHaveBeenCalledExactlyOnceWith(1_000, undefined);
    expect(api.retrieve).toHaveBeenCalledOnce();
    const bodies = vi.mocked(api.create).mock.calls.map(([body]) => body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      background: true,
      store: true,
      parallel_tool_calls: false,
      metadata: { config_hash: configHash },
    });
    expect(bodies[1]).toMatchObject({ previous_response_id: 'response-1' });
    for (const body of bodies) {
      expect(body.context_management).toEqual([{ type: 'compaction', compact_threshold: 244_800 }]);
      expect(body).not.toHaveProperty('conversation');
      expect(body.tools).toEqual([
        expect.objectContaining({
          server_label: 'arena_cursor',
          allowed_tools: ARENA_TOOL_NAMES,
          require_approval: 'never',
        }),
      ]);
      expect(body).not.toHaveProperty('instructions');
    }
    const initial = bodies[0]!.input as Array<{ role: string; content: string }>;
    expect(initial).toEqual([{ role: 'system', content: expect.any(String) }]);
    for (const phrase of [
      'You are player-1. Your biography is your background; your private goals are what you want.',
      'Before acting, privately consider: What matters to me here?',
      'without explaining your persona or narrating this reflection.',
      'Play.',
      'Begin by calling `get_rules` once, then call `get_status`.',
      'Pass after_cursor: null for a full snapshot;',
      'on later turns, use the last returned next_cursor.',
      'While has_more is true, call get_status again with next_cursor before choosing your action.',
      'Use null again if you need a full refresh.',
      'read unread messages and send any appropriate messages before calling get_actions',
      'submitting exactly one legal action with submit_action.',
      'Sending is allowed only when can_send_message is true.',
      'Messaging is separate from the one submit_action limit.',
      'After submitting, end this response.',
      'If waiting or complete, end immediately. Never poll repeatedly in one response.',
    ])
      expect(initial[0]!.content).toContain(phrase);
    expect(initial[0]!.content).not.toMatch(/response_id|response-1|https:\/\//);
    expect(bodies[1]!.input).toBe(turnPrompt);
    expect(result.map(({ id }) => id)).toEqual(['response-1', 'response-2']);
    expect(result[0]!.output).toEqual(rejected('response-1'));
  });
  it.each(['arena', 'arena_cursor'])(
    'resolves only eight trusted %s cursors from the same simulation and config',
    async (serverLabel) => {
      const api = mockApi({
        retrieve: async (id) =>
          response(
            id,
            'completed',
            output(id),
            id.replace('seat-', 'player-'),
            `https://arena.test/mcp/${id}-capability-0000000000000000`,
            serverLabel,
          ),
      });
      const ids = Array.from({ length: 8 }, (_, index) => `seat-${index + 1}`);
      const players = Array.from({ length: 8 }, (_, index) => `player-${index + 1}`);
      const seats = await resolveResponseSeats(ids, 'gpt-5.6-luna', 'medium', mcpUrl, players, api);
      expect(seats).toHaveLength(8);
      expect(new Set(seats.map((seat) => seat.configHash))).toEqual(new Set([configHash]));
      await expect(
        resolveResponseSeats(ids, 'gpt-5.6-luna', 'medium', mcpUrl, players, {
          ...api,
          retrieve: async (id) => {
            const value = response(
              id,
              'completed',
              output(id),
              id.replace('seat-', 'player-'),
              `https://arena.test/mcp/${id}-capability-0000000000000000`,
            );
            (value.tools[0] as any).allowed_tools = ARENA_TOOL_NAMES.slice(1);
            return value;
          },
        }),
      ).rejects.toThrow('does not match');
      await expect(
        resolveResponseSeats(ids, 'gpt-5.6-luna', 'medium', mcpUrl, players, {
          ...api,
          retrieve: async (id) =>
            response(id, 'completed', output(id), 'player-1', mcpUrl, 'other'),
        }),
      ).rejects.toThrow('does not match');
      await expect(
        resolveResponseSeats(ids, 'gpt-5.6-luna', 'medium', mcpUrl, players, {
          ...api,
          retrieve: async (id) => response(id, 'completed', output(id), 'player-1', `${mcpUrl}/x`),
        }),
      ).rejects.toThrow('untrusted');
      const resumed = await runResponsesSeat(
        { ...input(['complete']), resumeId: 'response-2' },
        api,
      );
      expect(resumed.map(({ id }) => id)).toEqual(['response-1', 'response-2']);
    },
  );
  it('fails closed and cancels a Response whose polling fails', async () => {
    const cancelled: string[] = [];
    const api = mockApi({
      create: async () => response('response-1', 'queued'),
      retrieve: async () => Promise.reject(new Error('poll failed')),
      cancel: async (id) => (cancelled.push(id), response(id, 'cancelled')),
    });
    await expect(runResponsesSeat(input([]), api, async () => undefined)).rejects.toThrow(
      'poll failed',
    );
    const failedCreate = vi.fn(async () => ({
      ...response('response-2', 'failed'),
      error: { code: 'invalid_prompt' as const, message: 'terminal failure' },
    }));
    await expect(runResponsesSeat(input([]), { ...api, create: failedCreate })).rejects.toThrow(
      'Response response-2 ended failed',
    );
    expect(failedCreate).toHaveBeenCalledOnce();
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(900_000);
    await expect(
      runResponsesSeat(
        input([]),
        { ...api, retrieve: async () => response('response-1', 'queued') },
        async () => undefined,
      ),
    ).rejects.toThrow('queue deadline');
    now.mockRestore();
    expect(cancelled).toEqual(['response-1', 'response-1']);
  });
  it('journals raw turns under seat filenames without interpreting player IDs or secret-like keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pokerbeer-responses-'));
    process.env.RESPONSES_EVENT_LOG_DIR = dir;
    const api = mockApi({
      create: async () => response('response-1', 'queued'),
      retrieve: async () => {
        // The acknowledged ID must be on disk before completion, for interruption evidence.
        expect(JSON.parse(await readFile(join(dir, 'seat-1.cursor.json'), 'utf8'))).toMatchObject({
          response_id: 'response-1',
        });
        return response('response-1', 'completed');
      },
      cancel: async () => response('response-1', 'cancelled'),
    });
    try {
      await runResponsesSeat(
        { ...input(['complete']), playerId: '../api_key' },
        api,
        async () => undefined,
      );
      const events = await readFile(join(dir, 'seat-1.jsonl'), 'utf8');
      expect(
        events
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toMatchObject([
        {
          event: 'created',
          response_id: 'response-1',
          player_id: '../api_key',
          request: {
            input: [{ role: 'system', content: expect.stringContaining('You are ../api_key.') }],
          },
        },
        { event: 'retrieved', response_id: 'response-1' },
        { event: 'finished', response_id: 'response-1', response: { usage: { input_tokens: 10 } } },
      ]);
      expect(events).toContain(mcpUrl);
      expect(JSON.parse(await readFile(join(dir, 'seat-1.cursor.json'), 'utf8'))).toEqual({
        seat: 1,
        player_id: '../api_key',
        simulation_id: 'simulation-1',
        config_hash: configHash,
        response_id: 'response-1',
      });
      expect((await readdir(dir)).sort()).toEqual(['seat-1.cursor.json', 'seat-1.jsonl']);
    } finally {
      delete process.env.RESPONSES_EVENT_LOG_DIR;
      await rm(dir, { recursive: true });
    }
  });
  it('aborts and awaits sibling preflight reads while preserving the original failure', async () => {
    const original = new Error('Invalid stored response');
    let stopped = 0;
    const api = mockApi({
      retrieve: async (id, _query, options) => {
        if (id === 'bad') throw original;
        return new Promise((_, reject) =>
          options!.signal!.addEventListener(
            'abort',
            () => {
              stopped += 1;
              reject(options!.signal!.reason);
            },
            { once: true },
          ),
        );
      },
    });
    await expect(
      resolveResponseSeats(
        ['bad', ...Array.from({ length: 7 }, (_, i) => `pending-${i}`)],
        'gpt-5.6-luna',
        'medium',
        mcpUrl,
        [],
        api,
        undefined,
        recordEvent,
      ),
    ).rejects.toBe(original);
    expect(stopped).toBe(7);
    expect(api.cancel).not.toHaveBeenCalled();
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(8);
  });
  it('rejects empty resume entries before asking the provider to retrieve them', async () => {
    const api = mockApi();
    await expect(
      resolveResponseSeats(
        [' ', ...Array(7).fill('response')],
        'gpt-5.6-luna',
        'medium',
        mcpUrl,
        [],
        api,
      ),
    ).rejects.toThrow('nonempty');
    expect(api.retrieve).not.toHaveBeenCalled();
  });
  it('preserves SDK retries and raw cancellation output, request IDs, and HTTP errors', async () => {
    const calls: string[] = [];
    const cancelled = response('response-1', 'cancelled');
    (cancelled.output[0] as any).arguments = '{"password":';
    delete (cancelled as any).output_text;
    const client = new OpenAI({
      apiKey: 'fake-test-key',
      fetch: async (url, options) => {
        const operation = String(url).endsWith('/cancel')
          ? 'cancel'
          : options?.method === 'POST'
            ? 'create'
            : 'retrieve';
        calls.push(operation);
        if (operation === 'retrieve')
          return globalThis.Response.json(
            { error: { message: 'poll secret', code: 'server_error', secret: 'exact detail' } },
            {
              status: 503,
              headers: {
                'retry-after-ms': '1',
                'x-request-id': 'request-error',
                'x-secret': 'preserve',
              },
            },
          );
        return globalThis.Response.json(
          operation === 'create' ? response('response-1', 'queued') : cancelled,
          { headers: { 'x-request-id': `request-${operation}` } },
        );
      },
    });
    await expect(
      runResponsesSeat(input([]), client.responses, async () => undefined),
    ).rejects.toThrow('poll secret');
    expect(calls).toEqual(['create', ...Array(9).fill('retrieve'), 'cancel']);
    expect(events.find(({ event }) => event === 'created')).toMatchObject({
      request_id: 'request-create',
      request: { background: true, store: true },
    });
    expect(events.find(({ event }) => event === 'cancelled')).toMatchObject({
      request_id: 'request-cancel',
      response: cancelled,
    });
    expect(events.filter(({ operation }) => operation === 'request_retry')).toHaveLength(2);
    expect(
      events.find(({ event, operation }) => event === 'error' && operation === 'retrieve'),
    ).toMatchObject({
      operation: 'retrieve',
      error: {
        status: 503,
        requestID: 'request-error',
        headers: { 'x-secret': 'preserve' },
        error: { secret: 'exact detail' },
      },
    });
  });
  it('reports cancellation failure alongside the original error without restarting a response', async () => {
    const original = new Error('poll failed');
    const cancelError = new Error('cancel failed');
    const api = mockApi({
      create: vi.fn(async () => response('response-1', 'queued')),
      retrieve: vi.fn().mockRejectedValue(original),
      cancel: vi.fn().mockRejectedValue(cancelError),
    });
    const failure = await runResponsesSeat(input([]), api, async () => undefined).catch(
      (error: AggregateError) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, cancelError]);
    expect(
      events.filter(({ event }) => event === 'error').map(({ operation }) => operation),
    ).toEqual(['retrieve', 'cancel']);
    expect(api.create).toHaveBeenCalledOnce();
  });
  it('records an unsuccessful create with the exact request and original error', async () => {
    const original = new Error('create connection lost', { cause: new Error('socket closed') });
    const api = mockApi({ create: vi.fn().mockRejectedValue(original) });
    await expect(runResponsesSeat(input([]), api)).rejects.toBe(original);
    expect(events).toMatchObject([
      {
        event: 'error',
        operation: 'create',
        error: { message: original.message, cause: { message: 'socket closed' } },
        request: {
          model: 'gpt-5.6-luna',
          background: true,
          store: true,
          tools: [{ server_url: mcpUrl }],
          input: [{ role: 'system', content: expect.stringContaining('Play.') }],
        },
      },
    ]);
    expect(events[0]).not.toHaveProperty('response_id');
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it.each(['retrieve', 'cancel'])(
    'preserves the original failure when %s error evidence cannot be written',
    async (operation) => {
      const original = new Error('original poll failure');
      const cancelError = new Error('cancel failure');
      const writeError = new Error('journal unavailable');
      const api = mockApi({
        create: async () => response('response-1', 'queued'),
        retrieve: vi.fn().mockRejectedValue(original),
        cancel: async () => {
          if (operation === 'cancel') throw cancelError;
          return response('response-1', 'cancelled');
        },
      });
      const failed = await runResponsesSeat(
        {
          ...input([]),
          onEvent: (event) => {
            if (event.event === 'error' && event.operation === operation) throw writeError;
          },
        },
        api,
        async () => undefined,
      ).catch((error: AggregateError) => error);
      expect(failed).toBeInstanceOf(AggregateError);
      expect((failed as AggregateError).errors[1]).toBe(writeError);
      if (operation === 'cancel')
        expect(((failed as AggregateError).errors[0] as AggregateError).errors).toEqual([
          original,
          cancelError,
        ]);
      else expect((failed as AggregateError).cause).toBe(original);
    },
  );
  it('compares exact player IDs even when different sets have identical comma-joined text', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `seat-${i + 1}`);
    const shared = ['p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const actual = ['a', 'b,c', ...shared];
    const expected = ['a,b', 'c', ...shared];
    expect(actual.join(',')).toBe(expected.join(','));
    const api = mockApi({
      retrieve: async (id) =>
        response(
          id,
          'completed',
          output(id),
          actual[ids.indexOf(id)]!,
          `https://arena.test/mcp/${id}-capability-0000000000000000`,
        ),
    });
    await expect(
      resolveResponseSeats(ids, 'gpt-5.6-luna', 'medium', mcpUrl, expected, api),
    ).rejects.toThrow('eight Responses seats');
    expect(
      (await resolveResponseSeats(ids, 'gpt-5.6-luna', 'medium', mcpUrl, actual, api)).map(
        ({ playerId }) => playerId,
      ),
    ).toEqual(actual);
  });
});
