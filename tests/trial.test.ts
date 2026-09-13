import type { Response } from 'openai/resources/responses/responses';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARENA_TOOL_NAMES,
  runTrial,
  TrialFailure,
  type TrialDependencies,
  type TrialMcpClient,
  type TrialOptions,
} from '../harbor/runner/run.ts';
import { runResponsesSeat, type ResponsesSeatInput } from '../harbor/runner/responses.ts';
import { main } from '../harbor/runner/main.ts';
import { version } from '../package.json';
import { VERSION } from 'openai/version';
const players = Array.from({ length: 8 }, (_, index) => `player-${index + 1}`);
const operatorUrl = 'https://arena.test/mcp/operator-capability-0000000000000000';
const creatorUrl = `${operatorUrl}?create`;
const configHash = 'c'.repeat(64);
const seatUrls = players.map(
  (_, index) => `https://arena.test/mcp/seat-capability-${index}-0000000000000000`,
);
function response(playerId: string): Response {
  const index = players.indexOf(playerId);
  return {
    id: `response-${playerId}`,
    status: 'completed',
    output: [
      {
        type: 'reasoning',
        id: `reasoning-${playerId}`,
        summary: [{ type: 'summary_text', text: 'think' }],
      },
      {
        type: 'mcp_call',
        id: `call-${playerId}`,
        name: 'get_status',
        server_label: 'arena',
        arguments: `{"url":"${seatUrls[0]}"}`,
        output: '{"state":"complete"}',
        status: 'completed',
      },
    ],
    output_text: `done ${operatorUrl}`,
    model: 'test-model',
    created_at: 1,
    completed_at: 2,
    previous_response_id: null,
    metadata: { simulation_id: 'simulation-1', config_hash: configHash, player_id: playerId },
    reasoning: { effort: 'medium', summary: 'auto' },
    tools: [
      {
        type: 'mcp',
        server_label: 'arena',
        server_url: seatUrls[index],
        allowed_tools: ARENA_TOOL_NAMES,
        require_approval: 'never',
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 1 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
    api_key: 'nested-secret',
  } as unknown as Response;
}
const waitForAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
function options(): TrialOptions {
  return {
    creation: {
      players: players.map((id) => ({ id, publicBiography: `${id} biography` })),
      beerDemand: { mode: 'static', value: 4 },
    },
    arenaMcpUrl: operatorUrl,
    model: 'test-model',
    reasoning: 'medium',
    instruction: 'Play until complete.',
    trialId: 'trial-1',
    sessionName: 'session-1',
    timeoutMs: 5_000,
  };
}
function fakeDependencies(
  settings: {
    terminalStatus?: 'running' | 'completed';
    tools?: string[];
    failPlayer?: string;
    result?: Record<string, unknown>;
    playerTool?: TrialMcpClient['callTool'];
    exportError?: string;
  } = {},
) {
  const inputs: ResponsesSeatInput[] = [];
  const connections: string[] = [];
  const close = vi.fn<TrialMcpClient['close']>().mockResolvedValue(undefined);
  let statusCalls = 0;
  let abortedSeats = 0;
  const result = settings.result ?? {
    valid: true as const,
    pokerB: {
      scores: players.map((playerId, index) => ({ playerId, place: index + 1, score: 8 - index })),
    },
  };
  const dependencies: TrialDependencies = {
    async resolveSeats(ids) {
      return players.map((playerId, index) => ({
        simulationId: 'simulation-1',
        configHash,
        playerId,
        url: seatUrls[index]!,
        resumeId: ids[index]!,
      }));
    },
    async connectMcp(url) {
      connections.push(url);
      return {
        async listTools() {
          return { tools: (settings.tools ?? [...ARENA_TOOL_NAMES]).map((name) => ({ name })) };
        },
        async callTool(input) {
          if (input.name === 'get_actions')
            return url === seatUrls[0] && settings.playerTool
              ? settings.playerTool(input)
              : { structuredContent: { actions: [] } };
          if (input.name === 'create_simulation') {
            return {
              structuredContent: {
                ok: true,
                simulation_id: 'simulation-1',
                players: players.map((player_id, index) => ({
                  player_id,
                  mcp_url: seatUrls[index],
                })),
              },
            };
          }
          if (input.name === 'get_simulation') {
            statusCalls += 1;
            const terminal = statusCalls > 1 && settings.terminalStatus === 'running';
            return {
              structuredContent: {
                ok: true,
                simulation_id: 'simulation-1',
                config_hash: configHash,
                status: terminal ? 'running' : 'completed',
                stage: terminal ? 'poker_a' : 'complete',
              },
            };
          }
          if (settings.exportError) throw new Error(settings.exportError);
          return { structuredContent: { ok: true, manifest: {}, result, events: [] } };
        },
        close,
      };
    },
    async runSeat(input) {
      inputs.push(input);
      if (settings.failPlayer === input.playerId) throw new Error('Responses chain failed');
      if (settings.failPlayer)
        return new Promise<Response[]>((_, reject) =>
          input.abortSignal!.addEventListener(
            'abort',
            () => {
              abortedSeats += 1;
              reject(new Error('Seat aborted'));
            },
            { once: true },
          ),
        );
      return [response(input.playerId)];
    },
  };
  return {
    dependencies,
    inputs,
    connections,
    closeCount: () => close.mock.calls.length,
    statusCalls: () => statusCalls,
    abortedSeats: () => abortedSeats,
  };
}
describe('trial runner', () => {
  it.each(
    [false, true].flatMap((resume) =>
      ['timeout', 'busy'].flatMap((kind) =>
        [1, 2].map((retries) => [resume, kind, retries] as const),
      ),
    ),
  )(
    'rechecks compact MCP readiness without replaying a turn (resume=%s, error=%s, retries=%s)',
    async (resume, kind, retries) => {
      const timeout = Object.assign(new Error('Request timed out after 5000ms'), {
        name: 'MCPClientError',
      });
      let statusCalls = 0;
      const fake = fakeDependencies({
        playerTool: async ({ name }) => {
          expect(name).toBe('get_actions');
          if (++statusCalls <= retries) {
            if (kind === 'timeout') throw timeout;
            return {
              isError: true,
              structuredContent: { error: { code: 'BUSY' }, retry_after_ms: 1_000 },
            };
          }
          return {
            structuredContent: {
              actions: statusCalls === retries + 2 ? [{ action_id: 'poker.check' }] : [],
              ...(statusCalls === retries + 1 ? { retry_after_ms: 1_234 } : {}),
            },
          };
        },
      });
      const requests: Array<{ previous_response_id?: string | null }> = [];
      const waits: number[] = [];
      fake.dependencies.runSeat = (seat) =>
        runResponsesSeat(
          {
            ...seat,
            waitForTurn: async (ms) => {
              waits.push(ms);
            },
          },
          {
            create: async (body) => {
              if (seat.playerId === players[0]) requests.push(body);
              return {
                ...response(seat.playerId),
                id: `${seat.playerId}-turn-${requests.length}`,
                previous_response_id: body.previous_response_id ?? null,
              };
            },
            retrieve: async (id) => ({ ...response(seat.playerId), id }),
            cancel: vi.fn(),
          },
        );
      const result = await runTrial(
        { ...options(), ...(resume ? { resumeIds: players.map((id) => `saved-${id}`) } : {}) },
        fake.dependencies,
      );
      expect(result.harness.status).toBe('completed');
      expect(statusCalls).toBe(retries + 3);
      expect(waits).toEqual([...Array(retries).fill(1_000), 1_234]);
      expect(requests.map(({ previous_response_id }) => previous_response_id)).toEqual(
        resume ? ['saved-player-1'] : [undefined, 'player-1-turn-1'],
      );
      expect(JSON.stringify(result.trajectory)).toContain(
        kind === 'timeout' ? timeout.message : 'BUSY',
      );
      expect(fake.closeCount()).toBe(9);
    },
  );
  it.each(['deadline', 'abort', 'authorization', 'application', 'untyped'] as const)(
    'does not retry status errors beyond the intended boundary: %s',
    async (scenario) => {
      const abort = new AbortController();
      const error =
        scenario === 'untyped'
          ? new Error('Request timed out after 5000ms')
          : Object.assign(
              new Error(
                scenario === 'authorization' ? 'Forbidden' : 'Request timed out after 5000ms',
              ),
              {
                name: 'MCPClientError',
                ...(scenario === 'authorization' ? { statusCode: 403 } : {}),
                ...(scenario === 'application' ? { code: -32602 } : {}),
              },
            );
      let calls = 0;
      const fake = fakeDependencies({
        playerTool: async () => {
          calls += 1;
          if (scenario === 'abort') abort.abort(new Error('stop'));
          throw error;
        },
      });
      let creates = 0;
      fake.dependencies.runSeat = (seat) =>
        runResponsesSeat(seat, {
          create: async () => {
            creates += 1;
            return response(seat.playerId);
          },
          retrieve: vi.fn(),
          cancel: vi.fn(),
        });
      await expect(
        runTrial(
          {
            ...options(),
            timeoutMs: scenario === 'deadline' ? 30 : 5_000,
            abortSignal: abort.signal,
          },
          fake.dependencies,
        ),
      ).rejects.toMatchObject({
        output: {
          harness: {
            status:
              scenario === 'deadline'
                ? 'timed_out'
                : scenario === 'abort'
                  ? 'interrupted'
                  : 'failed',
          },
        },
      });
      if (scenario === 'deadline') expect(calls).toBeGreaterThan(0);
      else expect(calls).toBe(1);
      expect(creates).toBe(8);
      expect(fake.closeCount()).toBe(9);
    },
  );
  it('wakes only its own seats, retains missed notifications, and keeps fallback polling', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trials = [fakeDependencies(), fakeDependencies()];
    for (const trial of trials) {
      trial.dependencies.runSeat = async (input) => {
        trial.inputs.push(input);
        await held;
        return [response(input.playerId)];
      };
    }
    const runs = trials.map((trial) => runTrial(options(), trial.dependencies));
    try {
      await vi.waitFor(() => expect(trials.map(({ inputs }) => inputs.length)).toEqual([8, 8]));
      const first = trials[0]!.inputs;
      const other = trials[1]!.inputs;
      let seatsWoken = 0;
      const waiting = first.slice(0, 6).map((seat) =>
        seat.waitForTurn!(30_000).then(() => {
          seatsWoken += 1;
        }),
      );
      let otherWoke = false;
      const otherWaiting = other[0]!.waitForTurn!(30_000).then(() => {
        otherWoke = true;
      });
      // Nonterminal provider events must not wake anyone.
      await first[0]!.onEvent!({ event: 'retrieved' });
      await nextTick();
      expect(seatsWoken).toBe(0);
      await first[6]!.onEvent!({ event: 'finished' });
      await Promise.all(waiting);
      expect(seatsWoken).toBe(6);
      // Seat eight was checking status when the notification arrived.
      await first[7]!.waitForTurn!(30_000);
      await nextTick();
      expect(otherWoke).toBe(false);
      // The finishing seat must consume its own notification; both seats use fallback polling.
      let fallbackElapsed = 0;
      const fallback = first.slice(6).map((seat) =>
        seat.waitForTurn!(30).then(() => {
          fallbackElapsed += 1;
        }),
      );
      await nextTick();
      expect(fallbackElapsed).toBe(0);
      await Promise.all(fallback);
      expect(fallbackElapsed).toBe(2);
      await other[1]!.onEvent!({ event: 'finished' });
      await otherWaiting;
      expect(otherWoke).toBe(true);
    } finally {
      release();
      await Promise.all(runs);
    }
    expect(trials.map((trial) => trial.closeCount())).toEqual([9, 9]);
  });
  it.each(['timeout', 'interrupt'] as const)(
    'stops turn waits on %s and preserves all eight seats without empty child trajectories',
    async (mode) => {
      const fake = fakeDependencies();
      const abort = new AbortController();
      fake.dependencies.runSeat = async (input) => {
        fake.inputs.push(input);
        if (mode === 'interrupt' && fake.inputs.length === 8) {
          // Cancellation must win even when a finished notification is already pending.
          await input.onEvent!({ event: 'finished' });
          abort.abort(new Error('test interruption'));
        }
        await input.waitForTurn!(30_000);
        input.abortSignal!.throwIfAborted();
        return [response(input.playerId)];
      };
      const failure = await runTrial(
        {
          ...options(),
          timeoutMs: mode === 'timeout' ? 30 : 5_000,
          abortSignal: abort.signal,
        },
        fake.dependencies,
      ).catch((error: TrialFailure) => error);
      expect(failure).toBeInstanceOf(TrialFailure);
      expect(failure).toMatchObject({
        output: {
          harness: { status: mode === 'timeout' ? 'timed_out' : 'interrupted' },
        },
      });
      const trajectory = (failure as TrialFailure).output.trajectory;
      expect(trajectory.subagent_trajectories).toEqual([]);
      expect(trajectory.extra.seats_without_turns).toHaveLength(8);
      expect(trajectory.extra.seats_without_turns.map((seat) => seat.session_id)).toEqual(
        fake.inputs.map((input) => `${input.simulationId}-${input.playerId}`),
      );
      expect(fake.inputs).toHaveLength(8);
      expect(fake.closeCount()).toBe(9);
    },
  );
  it('runs eight raw Responses seats and exports full-fidelity Harbor evidence', async () => {
    const fake = fakeDependencies();
    const output = await runTrial(options(), fake.dependencies);
    expect(fake.connections).toHaveLength(9);
    expect(fake.connections[0]).toBe(creatorUrl);
    expect(fake.inputs).toHaveLength(8);
    expect(fake.inputs.map(({ mcpUrl }) => mcpUrl)).toEqual(seatUrls);
    expect(fake.inputs.every(({ configHash: hash }) => hash === configHash)).toBe(true);
    expect(fake.closeCount()).toBe(9);
    expect(fake.statusCalls()).toBe(2);
    expect(output.trajectory.schema_version).toBe('ATIF-v1.7');
    expect(output.trajectory.subagent_trajectories).toHaveLength(8);
    expect(
      new Set(output.trajectory.subagent_trajectories.map((child) => child.trajectory_id)).size,
    ).toBe(8);
    expect(output.trajectory.agent.extra).toMatchObject({
      reasoning: 'medium',
      model: 'test-model',
      provider: 'openai-responses',
      sdk_version: VERSION,
    });
    expect(output.trajectory.agent.version).toBe(version);
    expect(output.trajectory.subagent_trajectories[0]!.steps[0]).toMatchObject({
      step_id: 1,
      source: 'agent',
      model_name: 'test-model',
      message: `done ${operatorUrl}`,
      reasoning_content: 'think',
      metrics: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 1 },
      tool_calls: [{ function_name: 'get_status' }],
      extra: { response: { id: 'response-player-1', status: 'completed' } },
    });
    const artifact = JSON.stringify(output);
    expect(artifact).toContain('nested-secret');
    expect(artifact).toContain(operatorUrl);
    expect(seatUrls.every((url) => artifact.includes(url))).toBe(true);
    expect(output.harness).toEqual({ status: 'completed' });
    expect(output.trajectory.extra.result).toEqual(output.result);
  });
  it('renders native output text at production without altering the stored Response', async () => {
    const fake = fakeDependencies();
    const native = response(players[0]!);
    delete (native as Partial<Response>).output_text;
    native.output.push({
      type: 'message',
      id: 'message-1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Native message', annotations: [] }],
    });
    fake.dependencies.runSeat = async () => [native];
    vi.stubEnv('HARBOR_VERSION', '0.22.0');
    try {
      const { trajectory } = await runTrial(options(), fake.dependencies);
      expect(trajectory.agent.extra.harbor_version).toBe('0.22.0');
      expect(trajectory.subagent_trajectories[0]!.steps[0]).toMatchObject({
        message: 'Native message',
        extra: { response: native },
      });
      expect(native).not.toHaveProperty('output_text');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('resumes only when all cursors match the current config checkpoint', async () => {
    const fake = fakeDependencies();
    const resumed = options();
    resumed.resumeIds = players.map((_, index) => `response-${index + 1}`);
    const output = await runTrial(resumed, fake.dependencies);
    expect(
      output.trajectory.subagent_trajectories.every((child) =>
        child.steps.every((step) => step.source === 'agent'),
      ),
    ).toBe(true);
    expect(fake.inputs.map(({ resumeId }) => resumeId)).toEqual(
      players.map((_, index) => `response-${index + 1}`),
    );
    const reordered = fakeDependencies();
    const resolve = reordered.dependencies.resolveSeats;
    reordered.dependencies.resolveSeats = async (...args) => (await resolve(...args)).reverse();
    await runTrial(resumed, reordered.dependencies);
    expect(reordered.inputs.map(({ playerId, seat }) => [playerId, seat])).toEqual(
      players.map((id, index) => [id, index + 1]),
    );
    await expect(
      runTrial(resumed, {
        ...fake.dependencies,
        resolveSeats: async (...args) =>
          (await fake.dependencies.resolveSeats(...args)).map((seat) => ({
            ...seat,
            configHash: 'd'.repeat(64),
          })),
      }),
    ).rejects.toThrow('checkpoint');
  });
  it('rejects a configured creator query instead of broadening the capability', async () => {
    const fake = fakeDependencies();
    const invalid = options();
    invalid.arenaMcpUrl = `${operatorUrl}?unexpected`;
    await expect(runTrial(invalid, fake.dependencies)).rejects.toThrow('query or fragment');
    expect(fake.connections).toHaveLength(0);
  });
  it('checks terminal state once after every seat returns', async () => {
    const fake = fakeDependencies({ terminalStatus: 'running' });
    await expect(runTrial(options(), fake.dependencies)).rejects.toThrow('before');
    expect(fake.inputs).toHaveLength(8);
    expect(fake.statusCalls()).toBe(2);
  });
  it('fails closed unless every seat exposes exactly the six Arena tools', async () => {
    const fake = fakeDependencies({ tools: ARENA_TOOL_NAMES.slice(0, 5) });
    await expect(runTrial(options(), fake.dependencies)).rejects.toThrow('exactly');
    expect(fake.inputs).toHaveLength(0);
  });
  it('aborts and closes every client when one Responses chain fails', async () => {
    const fake = fakeDependencies({ failPlayer: players[0]! });
    await expect(runTrial(options(), fake.dependencies)).rejects.toThrow('Responses chain failed');
    expect(fake.inputs).toHaveLength(8);
    expect(fake.abortedSeats()).toBe(7);
    expect(fake.closeCount()).toBe(9);
  });
  it('includes resume preflight in the trial deadline and exports its partial raw evidence', async () => {
    const fake = fakeDependencies();
    fake.dependencies.resolveSeats = async (
      _ids,
      _model,
      _reasoning,
      _url,
      _players,
      _api,
      signal,
      observe,
    ) => {
      await observe?.({
        event: 'retrieved',
        response_id: 'response-player-1',
        response: response(players[0]!),
      });
      return waitForAbort(signal!);
    };
    const failure = await runTrial(
      { ...options(), timeoutMs: 5, resumeIds: players },
      fake.dependencies,
    ).catch((error: TrialFailure) => error);
    expect(failure).toBeInstanceOf(TrialFailure);
    expect((failure as TrialFailure).output).toMatchObject({
      result: null,
      arena: null,
      harness: { status: 'timed_out', error: { message: 'Trial timed out.' } },
      trajectory: {
        extra: { resume_events: [{ response: response(players[0]!) }] },
        subagent_trajectories: [],
      },
    });
    expect(fake.connections).toHaveLength(0);
  });
  it('passes the deadline to MCP setup and discovery, and closes prepared clients on timeout', async () => {
    const fake = fakeDependencies();
    const connect = fake.dependencies.connectMcp;
    let listedSignal: AbortSignal | undefined;
    fake.dependencies.connectMcp = async (url, signal) => {
      expect(signal.aborted).toBe(false);
      const client = await connect(url, signal);
      if (url !== creatorUrl)
        client.listTools = async ({ options }) => {
          listedSignal = options.signal;
          expect(listedSignal).toBe(signal);
          return waitForAbort(options.signal);
        };
      return client;
    };
    await expect(runTrial({ ...options(), timeoutMs: 5 }, fake.dependencies)).rejects.toMatchObject(
      { output: { harness: { status: 'timed_out' } } },
    );
    expect(listedSignal?.aborted).toBe(true);
    expect(fake.closeCount()).toBe(2);
    expect(fake.inputs).toHaveLength(0);
  });
  it('keeps failed and cancelled tool payloads while preserving the canonical incomplete result', async () => {
    const canonical = { valid: false, status: 'running', api_key: 'a canonical field' };
    const fake = fakeDependencies({ result: canonical });
    const raw: Response = {
      ...response(players[0]!),
      status: 'failed',
      error: { code: 'invalid_prompt', message: 'provider failure' },
    };
    const cancelled = { ...response(players[1]!), status: 'cancelled' as const };
    (cancelled.output[1] as any).arguments = '{"password":';
    delete (cancelled as any).output_text;
    const cancellations: string[] = [];
    fake.dependencies.runSeat = (input) =>
      runResponsesSeat(
        input,
        {
          create: async () =>
            input.playerId === players[0]
              ? raw
              : { ...cancelled, id: `response-${input.playerId}`, status: 'queued' },
          retrieve: vi.fn(),
          cancel: async (id) => {
            cancellations.push(id);
            return { ...cancelled, id };
          },
        },
        async (_ms, signal) => waitForAbort(signal!),
      );
    const failure = await runTrial(options(), fake.dependencies).catch(
      (error: TrialFailure) => error,
    );
    expect(failure).toBeInstanceOf(TrialFailure);
    const output = (failure as TrialFailure).output;
    expect(output.result).toEqual(canonical);
    expect(output.harness.status).toBe('failed');
    const children = output.trajectory.subagent_trajectories;
    expect(children[0]!.steps[0]).toMatchObject({ extra: { response: raw } });
    expect(children[1]!.steps[0]).toMatchObject({
      tool_calls: [{ arguments: { raw_arguments: '{"password":' } }],
      extra: { response: cancelled },
    });
    expect(cancellations).toHaveLength(7);
    expect(fake.closeCount()).toBe(9);
  });
  it('keeps the primary failure when the final Arena export also fails', async () => {
    const fake = fakeDependencies({ failPlayer: players[0]!, exportError: 'export unavailable' });
    await expect(runTrial(options(), fake.dependencies)).rejects.toMatchObject({
      message: 'Responses chain failed',
      output: {
        result: null,
        arena: null,
        harness: {
          error: { message: 'Responses chain failed' },
          export_error: { message: 'export unavailable' },
        },
      },
    });
    expect(fake.closeCount()).toBe(9);
  });
});

describe('trial entry point', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pokerbeer-main-'));
    vi.stubEnv('OPENAI_API_KEY', 'fake-test-key');
    vi.stubEnv('ARENA_ORIGIN', new URL(operatorUrl).origin);
    vi.stubEnv('ARENA_MCP_SECRET', new URL(operatorUrl).pathname.split('/').at(-1)!);
    vi.stubEnv('RESPONSES_MODEL', 'test-model');
    vi.stubEnv('RESPONSES_REASONING_EFFORT', 'medium');
    vi.stubEnv('HARBOR_RESULT_PATH', join(dir, 'artifacts/result.json'));
    vi.stubEnv('HARBOR_TRAJECTORY_PATH', join(dir, 'agent/trajectory.json'));
    vi.stubEnv('HARBOR_ALLOCATION_PATH', undefined);
    vi.stubEnv('TRIAL_CREATION_PATH', undefined);
    vi.stubEnv('RESPONSES_EVENT_LOG_DIR', undefined);
    vi.stubEnv('RESPONSES_RESUME_IDS', undefined);
    vi.stubEnv('TRIAL_TIMEOUT_MS', '5000');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true });
  });
  const read = async (file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
  it('combines the explicit remote origin and secret for Harbor', async () => {
    const fake = fakeDependencies();
    const connectMcp = vi.spyOn(fake.dependencies, 'connectMcp');
    await main(fake.dependencies);
    expect(connectMcp).toHaveBeenCalledWith(creatorUrl, expect.any(AbortSignal));
  });
  it('requires an HTTPS Arena origin before making model or MCP calls', async () => {
    vi.stubEnv('ARENA_ORIGIN', 'http://localhost:3100');
    const fake = fakeDependencies();
    const connectMcp = vi.spyOn(fake.dependencies, 'connectMcp');
    const runSeat = vi.spyOn(fake.dependencies, 'runSeat');
    await expect(main(fake.dependencies)).rejects.toThrow('https://');
    expect(connectMcp).not.toHaveBeenCalled();
    expect(runSeat).not.toHaveBeenCalled();
  });
  it('writes the canonical result and separate completed harness report', async () => {
    await main(fakeDependencies().dependencies);
    const result = await read('artifacts/result.json');
    expect(result.valid).toBe(true);
    expect(await read('artifacts/harness.json')).toEqual({ status: 'completed' });
    expect((await read('artifacts/arena.json')).result).toEqual(result);
    expect((await read('agent/trajectory.json')).extra.result).toEqual(result);
  });
  it('defaults raw event journals beside the trajectory for direct CLI runs', async () => {
    const fake = fakeDependencies();
    fake.dependencies.runSeat = (input) =>
      runResponsesSeat(input, {
        create: async () => response(input.playerId),
        retrieve: vi.fn(),
        cancel: vi.fn(),
      });
    await main(fake.dependencies);
    const events = (await readFile(join(dir, 'agent/events/seat-1.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      event: 'created',
      player_id: 'player-1',
      request: { tools: [{ server_url: seatUrls[0] }] },
      response: { api_key: 'nested-secret' },
    });
    expect(events[1]).toMatchObject({ event: 'finished' });
  });
  it('writes failed resume evidence before propagating the original error', async () => {
    const fake = fakeDependencies();
    const original = new Error('invalid cursor with exact secret detail');
    fake.dependencies.resolveSeats = async () => {
      throw original;
    };
    vi.stubEnv('RESPONSES_RESUME_IDS', players.join(','));
    await expect(main(fake.dependencies)).rejects.toBe(original);
    expect(await read('artifacts/result.json')).toBeNull();
    expect(await read('artifacts/harness.json')).toMatchObject({
      status: 'failed',
      error: { message: original.message },
    });
    expect((await read('agent/trajectory.json')).subagent_trajectories).toEqual([]);
  });
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'exports interruption evidence on %s and removes its listener',
    async (signalName) => {
      const canonical = { valid: false, status: 'running' };
      const fake = fakeDependencies({ result: canonical });
      const listeners = process.listenerCount(signalName);
      let launched = 0;
      fake.dependencies.runSeat = async (input) => {
        await input.onEvent?.({
          event: 'created',
          response_id: `response-${input.playerId}`,
          response: response(input.playerId),
        });
        const stopped = waitForAbort(input.abortSignal!);
        launched += 1;
        if (launched === 8) process.emit(signalName, signalName);
        return stopped;
      };
      await expect(main(fake.dependencies)).rejects.toThrow(signalName);
      expect((await read('artifacts/harness.json')).status).toBe('interrupted');
      expect(await read('artifacts/result.json')).toEqual(canonical);
      expect((await read('agent/trajectory.json')).subagent_trajectories).toHaveLength(8);
      expect(process.listenerCount(signalName)).toBe(listeners);
      expect(fake.closeCount()).toBe(9);
    },
  );
});
