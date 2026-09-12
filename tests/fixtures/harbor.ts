import type { Response } from 'openai/resources/responses/responses';
import { loadConfig } from '../../src/shared.ts';
import {
  applyTournament,
  createTournament,
  tournamentActions,
  tournamentHistory,
  tournamentResult,
} from '../../src/game/tournament.ts';
import { buildAtif, type HarnessOutcome } from '../../harbor/runner/atif.ts';

const ids = ['Secret Agent', 'api_key', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
const config = await loadConfig('configs/benchmark.json');
config.players = ids.map((id) => ({ id, publicBiography: id }));
let snapshot = createTournament(config);
const initial = structuredClone(snapshot);
const milestones: Record<string, unknown>[] = [];
for (let step = 0; snapshot.stage !== 'complete'; step += 1) {
  if (step >= 5_000) throw new Error('Fixture tournament did not finish.');
  const actor = ids.find((id) => tournamentActions(snapshot, config, id).length)!;
  const actions = tournamentActions(snapshot, config, actor);
  const action =
    actions.find(({ actionId }) => actionId === 'poker.all_in') ??
    actions.find(({ actionId }) => actionId === 'poker.call') ??
    actions[0]!;
  const applied = applyTournament(snapshot, config, actor, {
    actionId: action.actionId,
    parameters: action.exampleParameters ?? {},
  });
  milestones.push(
    ...applied.effects.filter(({ kind }) => kind === 'milestone').map(({ data }) => data),
  );
  snapshot = applied.state;
}
const result = { valid: true, ...tournamentResult(tournamentHistory(milestones))! };
const rawResponse = {
  id: 'response-cancelled',
  status: 'cancelled',
  model: 'fixture-model',
  output: [
    {
      type: 'mcp_call',
      id: 'partial-call',
      name: 'submit_action',
      server_label: 'arena',
      arguments: '{"api_key":',
      output: null,
      error: { secret: 'preserved error' },
      status: 'in_progress',
    },
  ],
  metadata: { player_id: ids[0], api_key: 'provider-metadata' },
  tools: [
    { type: 'mcp', server_url: 'https://arena.test/mcp/exact-capability-0000000000000000000' },
  ],
  password: 'preserved extension',
  usage: null,
} as unknown as Response;
const completed = ids.map(
  (playerId) =>
    ({
      ...rawResponse,
      id: `response-${playerId}`,
      status: 'completed',
      output_text: 'done',
      metadata: { player_id: playerId },
      output: [
        {
          type: 'mcp_call',
          id: `call-${playerId}`,
          name: 'get_status',
          server_label: 'arena',
          arguments: '{}',
          output: '{"state":"complete"}',
          status: 'completed',
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }) as Response,
);
const common = {
  trialId: 'fixture',
  sessionName: 'fixture',
  model: 'fixture-model',
  reasoning: 'medium' as const,
  prompt: 'Play.',
};
function bundle(
  state: typeof snapshot | null,
  gameResult: unknown,
  responses: Array<Response | null>,
  harness: HarnessOutcome,
) {
  const arena = state
    ? {
        manifest: {
          status: state.stage === 'complete' ? 'completed' : 'running',
          stage: state.stage,
        },
        snapshot: state,
        result: gameResult,
        events: state.stage === 'complete' ? milestones : [],
      }
    : null;
  return {
    result: gameResult,
    arena,
    harness,
    trajectory: buildAtif({
      ...common,
      simulationId: state ? 'simulation-fixture' : null,
      result: gameResult,
      harness,
      seats: responses.map((response, index) => ({
        playerId: ids[index]!,
        sessionId: `fixture-seat-${index + 1}`,
        responses: response ? [response] : [],
        errors: response ? [] : [{ message: 'No new Response before interruption.' }],
        mcpCalls: response ? [] : [{ name: 'get_actions', response: { state: 'waiting' } }],
      })),
    }),
  };
}
console.log(
  JSON.stringify({
    success: bundle(snapshot, result, completed, { status: 'completed' }),
    partial: bundle(initial, { valid: false, status: 'running' }, [rawResponse], {
      status: 'interrupted',
      error: { message: 'SIGTERM', secret: 'exact failure' },
    }),
    resumed_partial: bundle(
      initial,
      { valid: false, status: 'running' },
      completed.map((response, index) => (index % 2 ? response : null)),
      { status: 'interrupted' },
    ),
    no_new_turns: bundle(
      initial,
      { valid: false, status: 'running' },
      ids.map(() => null),
      {
        status: 'interrupted',
      },
    ),
    preflight: bundle(null, null, [], {
      status: 'failed',
      error: { message: 'Invalid resume cursor.' },
    }),
    raw_response: rawResponse,
  }),
);
