import {
  clone,
  playerIds,
  seeded,
  type BenchmarkConfig,
  type PlayerId,
  type Stage,
} from '../shared.js';
import {
  applyPoker,
  createPoker,
  pokerActions,
  pokerResult,
  pokerView,
  type PokerAction,
  type PokerEffect,
  type PokerResult,
  type PokerState,
} from './poker.js';
import {
  applyBeerOrder,
  beerComplete,
  beerRotationCost,
  beerView,
  createBeer,
  maxBeerOrder,
  type BeerEffect,
  type BeerOutcome,
  type BeerPublicRotationResult,
  type BeerState,
} from './beer.js';
type DraftState = {
  winner: PlayerId;
  captains?: readonly [PlayerId, PlayerId];
  teams: Record<PlayerId, PlayerId[]>;
  available: PlayerId[];
  nextCaptain?: PlayerId | undefined;
};
export type TournamentState =
  | { version: 1; stage: 'poker_a' | 'poker_b'; poker: PokerState }
  | { version: 1; stage: 'draft'; draft: DraftState }
  | { version: 1; stage: 'beer'; beer: BeerState }
  | { version: 1; stage: 'complete' };
export type TournamentHistory = { pokerA?: PokerResult; beer?: BeerOutcome; pokerB?: PokerResult };
export type TournamentAction = {
  actionId: string;
  description: string;
  details?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  exampleParameters?: Record<string, unknown>;
};
export type TournamentStatus = {
  stage: Stage;
  complete: boolean;
  actionRequired: boolean;
  canSendMessage: boolean;
  view: unknown;
};
export type TournamentEffect = { kind: string; data: Record<string, unknown> };
export type PokerScore = { playerId: PlayerId; place: number; score: number };
export type TournamentResult = {
  pokerA: ScoredPoker;
  beer: {
    rotations: BeerPublicRotationResult[];
    totalCostByTeam: Record<PlayerId, number>;
    costByPlayer: Record<PlayerId, number>;
    winningTeamIds: PlayerId[];
    bonusPlayerIds: PlayerId[];
  };
  pokerB: ScoredPoker;
  reward: number;
};
type ScoredPoker = PokerResult & {
  scores: PokerScore[];
  placeGroups: { place: number; playerIds: PlayerId[] }[];
};
type ApplyInput = { actionId: string; parameters?: Record<string, unknown> };
const stacks = (players: readonly PlayerId[], amount: number): Record<PlayerId, number> =>
  Object.fromEntries(players.map((id) => [id, amount]));
export function createTournament(config: BenchmarkConfig): TournamentState {
  const players = playerIds(config);
  return {
    version: 1,
    stage: 'poker_a',
    poker: createPoker(
      players,
      stacks(players, config.poker.startingStack),
      { blindSchedule: config.poker.blindSchedule },
      `${config.seed}:poker_a`,
    ),
  };
}
export function tournamentCanMessage(stage: Stage): boolean {
  return stage === 'poker_a' || stage === 'draft' || stage === 'poker_b';
}
function pokerOptions(
  state: Extract<TournamentState, { stage: 'poker_a' | 'poker_b' }>,
  playerId: PlayerId,
): TournamentAction[] {
  return pokerActions(state.poker, playerId).map((option) => {
    const { id, ...details } = option;
    const amount =
      'minTo' in option
        ? {
            parameters: {
              to: { type: 'integer', required: true, minimum: option.minTo, maximum: option.maxTo },
            },
            exampleParameters: { to: option.minTo },
          }
        : {};
    return { actionId: `poker.${id}`, description: id.replace('_', ' '), details, ...amount };
  });
}
export function tournamentActions(
  state: TournamentState,
  config: BenchmarkConfig,
  playerId: PlayerId,
): TournamentAction[] {
  if (!playerIds(config).includes(playerId)) throw new Error('Unknown player.');
  if (state.stage === 'poker_a' || state.stage === 'poker_b') return pokerOptions(state, playerId);
  if (state.stage === 'beer') {
    if (!state.beer || Object.hasOwn(state.beer.pending, playerId)) return [];
    const exact = state.beer.week <= config.beer.warmupWeeks;
    const maximum = maxBeerOrder(config.beer);
    const example = exact
      ? config.beer.initialPipelineQuantity
      : Math.min(config.beer.initialPipelineQuantity, maximum);
    const quantity = exact
      ? { type: 'integer', required: true, exact: example }
      : { type: 'integer', required: true, minimum: 0, maximum };
    const description = exact
      ? `Order exactly ${example} units for warmup week ${state.beer.week}.`
      : `Order 0-${maximum} units for week ${state.beer.week}.`;
    return [
      {
        actionId: 'beer.order',
        description,
        parameters: { quantity },
        exampleParameters: { quantity: example },
      },
    ];
  }
  if (state.stage !== 'draft' || !state.draft) return [];
  const draft = state.draft;
  const playerChoice = { playerId: { type: 'string', required: true, choices: draft.available } };
  const playerExample = { playerId: draft.available[0]! };
  if (!draft.captains && playerId === draft.winner)
    return [
      { actionId: 'draft.first_pick', description: 'Take first pick; the other captain is drawn.' },
      {
        actionId: 'draft.choose_captain',
        description: 'Choose the opposing captain; first pick is drawn.',
        parameters: playerChoice,
        exampleParameters: playerExample,
      },
    ];
  return draft.nextCaptain === playerId
    ? [
        {
          actionId: 'draft.pick',
          description: 'Pick one teammate.',
          parameters: playerChoice,
          exampleParameters: playerExample,
        },
      ]
    : [];
}
export function tournamentStatus(
  state: TournamentState,
  config: BenchmarkConfig,
  playerId: PlayerId,
  history: TournamentHistory = {},
): TournamentStatus {
  if (
    (state.stage === 'draft' && !history.pokerA) ||
    (state.stage === 'poker_b' && !history.beer) ||
    (state.stage === 'complete' && !tournamentResult(history))
  )
    throw new Error('Tournament milestone history is incomplete.');
  const actions = tournamentActions(state, config, playerId);
  const complete = state.stage === 'complete';
  const poker = state.stage === 'poker_a' || state.stage === 'poker_b';
  const pokerRules = {
    objective: 'Be the last player with chips.',
    scoreFormula: '9 - final place',
    beerWinnerStackMultiplier: config.poker.finalWinnerStackMultiplier,
  };
  const pokerInfo = poker
    ? {
        ...pokerView(state.poker, playerId),
        tournamentRules: pokerRules,
        ...(state.stage === 'poker_b' && history.beer
          ? { beerOutcome: beerTotals(history.beer) }
          : {}),
      }
    : undefined;
  const draftInfo =
    state.stage === 'draft'
      ? { ...clone(state.draft), pokerAResult: clone(history.pokerA) }
      : undefined;
  const beerInfo =
    state.stage === 'beer'
      ? {
          ...beerView(state.beer, playerId, config.beer),
          pokerBReward: {
            lowerTotalCostWins: true,
            winningPlayerStackMultiplier: config.poker.finalWinnerStackMultiplier,
          },
        }
      : undefined;
  const view = poker
    ? pokerInfo
    : state.stage === 'draft'
      ? draftInfo
      : state.stage === 'beer'
        ? beerInfo
        : tournamentResult(history);
  return {
    stage: state.stage,
    complete,
    actionRequired: !!actions.length,
    canSendMessage: tournamentCanMessage(state.stage),
    view,
  };
}
const value = (input: ApplyInput, key: string): unknown => input.parameters?.[key];
const playerParam = (config: BenchmarkConfig, input: ApplyInput): PlayerId => {
  const id = value(input, 'playerId');
  if (typeof id !== 'string' || !playerIds(config).includes(id))
    throw new Error('Invalid player parameter.');
  return id;
};
function startDraft(config: BenchmarkConfig, result: PokerResult): TournamentState {
  return {
    version: 1,
    stage: 'draft',
    draft: {
      winner: result.winner,
      teams: {},
      available: playerIds(config).filter((id) => id !== result.winner),
    },
  };
}
export function beerTotals(beer: BeerOutcome): {
  totalCostByTeam: Record<PlayerId, number>;
  costByPlayer: Record<PlayerId, number>;
  winningTeamIds: PlayerId[];
  bonusPlayerIds: PlayerId[];
} {
  const totalCostByTeam = Object.fromEntries(beer.captains.map((id) => [id, 0]));
  const costByPlayer = Object.fromEntries(
    Object.values(beer.teams)
      .flat()
      .map((id) => [id, 0]),
  );
  for (const result of beer.results) {
    totalCostByTeam[result.teamId] =
      (totalCostByTeam[result.teamId] ?? 0) + beerRotationCost(result);
    for (const [id, cost] of Object.entries(result.costByPlayer))
      costByPlayer[id] = (costByPlayer[id] ?? 0) + cost;
  }
  const best = Math.min(...Object.values(totalCostByTeam));
  const winningTeamIds = beer.captains.filter((id) => totalCostByTeam[id] === best);
  return {
    totalCostByTeam,
    costByPlayer,
    winningTeamIds,
    bonusPlayerIds: winningTeamIds.flatMap((id) => beer.teams[id]!),
  };
}
function beginPokerB(config: BenchmarkConfig, beer: BeerState): TournamentState {
  const beerOutcome: BeerOutcome = clone({
    captains: beer.captains,
    teams: beer.teams,
    results: beer.results,
  });
  const bonus = new Set(beerTotals(beerOutcome).bonusPlayerIds);
  const boosted = config.poker.startingStack * config.poker.finalWinnerStackMultiplier;
  if (!Number.isSafeInteger(boosted) || boosted <= 0)
    throw new Error('Poker B bonus must produce a safe positive integer stack.');
  const players = playerIds(config);
  const starting = Object.fromEntries(
    players.map((id) => [id, bonus.has(id) ? boosted : config.poker.startingStack]),
  );
  const poker = createPoker(
    players,
    starting,
    { blindSchedule: config.poker.blindSchedule },
    `${config.seed}:poker_b`,
  );
  return { version: 1, stage: 'poker_b', poker };
}
function applyDraft(
  state: Extract<TournamentState, { stage: 'draft' }>,
  config: BenchmarkConfig,
  playerId: PlayerId,
  input: ApplyInput,
): { state: TournamentState; effects: TournamentEffect[] } {
  const draft = clone(state.draft);
  if (!draft.captains) {
    if (playerId !== draft.winner)
      throw new Error('Only the Poker A winner chooses draft privilege.');
    let opponent: PlayerId;
    let first: PlayerId;
    if (input.actionId === 'draft.first_pick') {
      opponent =
        draft.available[
          Math.floor(seeded(`${config.seed}:draft:captain`)() * draft.available.length)
        ]!;
      first = draft.winner;
    } else if (input.actionId === 'draft.choose_captain') {
      opponent = playerParam(config, input);
      if (opponent === draft.winner) throw new Error('Winner cannot oppose themself.');
      first = seeded(`${config.seed}:draft:first`)() < 0.5 ? draft.winner : opponent;
    } else throw new Error('Invalid draft action.');
    draft.captains = [draft.winner, opponent];
    draft.teams = { [draft.winner]: [draft.winner], [opponent]: [opponent] };
    draft.available = draft.available.filter((id) => id !== opponent);
    draft.nextCaptain = first;
    return {
      state: { ...state, draft },
      effects: [{ kind: 'draft_started', data: { captains: draft.captains, firstCaptain: first } }],
    };
  }
  if (input.actionId !== 'draft.pick' || draft.nextCaptain !== playerId)
    throw new Error('Draft pick is unavailable.');
  const picked = playerParam(config, input);
  if (!draft.available.includes(picked)) throw new Error('Player is not available.');
  draft.teams[playerId] = [...draft.teams[playerId]!, picked];
  draft.available = draft.available.filter((id) => id !== picked);
  const other = draft.captains.find((id) => id !== playerId)!;
  draft.nextCaptain = draft.available.length ? other : undefined;
  const effect: TournamentEffect = {
    kind: 'draft_pick',
    data: { captainId: playerId, playerId: picked },
  };
  if (draft.available.length) return { state: { ...state, draft }, effects: [effect] };
  const beer = createBeer(draft.captains, draft.teams, config.beer);
  return {
    state: { version: 1, stage: 'beer', beer },
    effects: [effect, { kind: 'milestone', data: { stage: 'beer', teams: draft.teams } }],
  };
}
export function applyTournament(
  state: TournamentState,
  config: BenchmarkConfig,
  playerId: PlayerId,
  input: ApplyInput,
): { state: TournamentState; effects: TournamentEffect[] } {
  if (!playerIds(config).includes(playerId)) throw new Error('Unknown player.');
  if (state.stage === 'draft') return applyDraft(state, config, playerId, input);
  if (state.stage === 'beer') {
    const quantity = value(input, 'quantity');
    if (input.actionId !== 'beer.order' || typeof quantity !== 'number')
      throw new Error('Invalid Beer action.');
    const applied = applyBeerOrder(state.beer, playerId, quantity, config.beer);
    const effects = applied.effects.map((item: BeerEffect) => ({
      kind: item.kind,
      data: item.data,
    }));
    return beerComplete(applied.state)
      ? {
          state: beginPokerB(config, applied.state),
          effects: [
            ...effects,
            {
              kind: 'milestone',
              data: {
                stage: 'poker_b',
                beerOutcome: clone({
                  captains: applied.state.captains,
                  teams: applied.state.teams,
                  results: applied.state.results,
                }),
              },
            },
          ],
        }
      : { state: { version: 1, stage: 'beer', beer: applied.state }, effects };
  }
  if (
    (state.stage !== 'poker_a' && state.stage !== 'poker_b') ||
    !input.actionId.startsWith('poker.')
  )
    throw new Error('Action is unavailable.');
  const id = input.actionId.slice(6) as PokerAction['id'];
  const action = (
    id === 'bet' || id === 'raise' ? { id, to: value(input, 'to') } : { id }
  ) as PokerAction;
  const applied = applyPoker(state.poker, playerId, action);
  const effects = applied.effects.map((effect: PokerEffect) => ({
    kind: 'poker',
    data: { stage: state.stage, effect },
  }));
  const result = pokerResult(applied.state);
  if (!result) return { state: { version: 1, stage: state.stage, poker: applied.state }, effects };
  if (state.stage === 'poker_a')
    return {
      state: startDraft(config, result),
      effects: [...effects, { kind: 'milestone', data: { stage: 'draft', pokerResult: result } }],
    };
  return {
    state: { version: 1, stage: 'complete' },
    effects: [...effects, { kind: 'milestone', data: { stage: 'complete', pokerResult: result } }],
  };
}
const scored = (result: PokerResult): ScoredPoker => ({
  ...clone(result),
  placeGroups: [...new Set(Object.values(result.placements))]
    .sort((a, b) => a - b)
    .map((place) => ({
      place,
      playerIds: Object.entries(result.placements)
        .filter(([, value]) => value === place)
        .map(([id]) => id),
    })),
  scores: Object.entries(result.placements).map(([playerId, place]) => ({
    playerId,
    place,
    score: 9 - place,
  })),
});
export function tournamentHistory(
  milestones: readonly Record<string, unknown>[],
): TournamentHistory {
  const history: TournamentHistory = {};
  for (const item of milestones) {
    if (item.stage === 'draft') {
      if (history.pokerA) throw new Error('Duplicate Poker A milestone.');
      history.pokerA = clone(item.pokerResult as PokerResult);
    } else if (item.stage === 'poker_b') {
      if (!history.pokerA || history.beer) throw new Error('Invalid Beer milestone.');
      history.beer = clone(item.beerOutcome as BeerOutcome);
    } else if (item.stage === 'complete') {
      if (!history.beer || history.pokerB) throw new Error('Invalid Poker B milestone.');
      history.pokerB = clone(item.pokerResult as PokerResult);
    }
  }
  return history;
}
export function tournamentResult(history: TournamentHistory): TournamentResult | null {
  if (!history.pokerA || !history.pokerB || !history.beer) return null;
  const beer = beerTotals(history.beer);
  const pokerB = scored(history.pokerB);
  return {
    pokerA: scored(history.pokerA),
    beer: {
      rotations: history.beer.results.map((result) => ({
        ...clone(result),
        totalCost: beerRotationCost(result),
      })),
      ...beer,
    },
    pokerB,
    reward: Math.max(...pokerB.scores.map(({ score }) => score)),
  };
}
