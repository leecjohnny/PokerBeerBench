import { describe, expect, it } from 'vitest';
import { loadConfig, sha256, type BenchmarkConfig, type PlayerId } from '../src/shared.ts';
import {
  applyBeerOrder,
  beerComplete,
  beerRotationCost,
  beerView,
  createBeer,
  deriveAssignments,
  maxBeerOrder,
  type BeerState,
} from '../src/game/beer.ts';
import {
  applyTournament,
  createTournament,
  tournamentActions,
  tournamentHistory,
  tournamentResult,
  tournamentStatus,
  type TournamentState,
} from '../src/game/tournament.ts';
import type { PokerResult } from '../src/game/poker.ts';
const players = Array.from({ length: 8 }, (_, index) => `p${index + 1}`);
const config: BenchmarkConfig = {
  version: 2,
  id: 'test',
  seed: 'test-seed',
  players: players.map((id) => ({ id, publicBiography: id })),
  messaging: { characterLimit: 1000 },
  poker: { startingStack: 100, finalWinnerStackMultiplier: 1.25, blindSchedule: [[1, 2, 2, 1]] },
  beer: {
    demandPack: { mode: 'static', id: '0'.repeat(64) },
    holdingCost: 0.5,
    backlogCost: 1,
    orderDelayWeeks: 2,
    shippingDelayWeeks: 2,
    factoryRequestDelayWeeks: 1,
    factoryProductionDelayWeeks: 2,
    initialInventory: 12,
    initialPipelineQuantity: 4,
    warmupWeeks: 4,
    demand: Array.from({ length: 4 }, () => Array(50).fill(4)),
  },
};
const teams: Record<PlayerId, PlayerId[]> = { p1: players.slice(0, 4), p5: players.slice(4) };
function orderAll(state: BeerState, count = 8): BeerState {
  let next = state;
  for (const id of players.slice(0, count)) next = applyBeerOrder(next, id!, 4, config.beer).state;
  return next;
}
function beerBeforeFinal(
  quantity: (state: BeerState, playerId: PlayerId) => number = () => 4,
): readonly [BeerState, string[]] {
  let state = createBeer(['p1', 'p5'], teams, config.beer);
  const openingRoles: string[] = [];
  for (let decision = 0; decision < 4 * 50 * 8 - 1; decision += 1) {
    if (state.week === 1 && !Object.keys(state.pending).length)
      openingRoles.push(beerView(state, 'p1', config.beer).role);
    const id = players.find((candidate) => state.pending[candidate] === undefined)!;
    state = applyBeerOrder(state, id, quantity(state, id), config.beer).state;
  }
  return [state, openingRoles];
}
function pokerResult(order = players): PokerResult {
  const placements = Object.fromEntries(order.map((id, index) => [id, index + 1]));
  return {
    winner: order[0]!,
    handsPlayed: 1,
    stacks: Object.fromEntries(order.map((id, index) => [id, index ? 0 : 800])),
    placements,
    totalChips: 800,
  };
}
function finishBeer(beer: BeerState, gameConfig = config) {
  return applyTournament({ version: 1, stage: 'beer', beer }, gameConfig, 'p8', {
    actionId: 'beer.order',
    parameters: { quantity: 4 },
  });
}
function finishTournament(gameConfig: BenchmarkConfig) {
  let state = createTournament(gameConfig);
  const milestones: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  const ids = gameConfig.players.map(({ id }) => id);
  for (let step = 0; state.stage !== 'complete'; step += 1) {
    if (step >= 5_000) throw new Error('Tournament did not finish.');
    const actor = ids.find((id) => tournamentActions(state, gameConfig, id).length)!;
    const options = tournamentActions(state, gameConfig, actor);
    const choice =
      options.find(({ actionId }) => actionId === 'poker.all_in') ??
      options.find(({ actionId }) => actionId === 'poker.call') ??
      options[0]!;
    counts[state.stage] = (counts[state.stage] ?? 0) + 1;
    const applied = applyTournament(state, gameConfig, actor, {
      actionId: choice.actionId,
      parameters: choice.exampleParameters ?? {},
    });
    milestones.push(
      ...applied.effects.filter(({ kind }) => kind === 'milestone').map(({ data }) => data),
    );
    state = JSON.parse(JSON.stringify(applied.state)) as TournamentState;
  }
  const history = tournamentHistory(JSON.parse(JSON.stringify(milestones)));
  return { counts, result: tournamentResult(history)! };
}
describe('Beer reducer', () => {
  it('derives roles from draft order and exposes only local prepared state', () => {
    expect(deriveAssignments(teams.p1!)).toEqual([
      { retailer: 'p1', wholesaler: 'p2', distributor: 'p3', factory: 'p4' },
      { retailer: 'p2', wholesaler: 'p3', distributor: 'p4', factory: 'p1' },
      { retailer: 'p3', wholesaler: 'p4', distributor: 'p1', factory: 'p2' },
      { retailer: 'p4', wholesaler: 'p1', distributor: 'p2', factory: 'p3' },
    ]);
    const state = createBeer(['p1', 'p5'], teams, config.beer);
    expect(beerView(state, 'p1', config.beer)).toEqual({
      rotation: 1,
      rotations: 4,
      week: 1,
      weeks: 50,
      teamId: 'p1',
      teamPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      role: 'retailer',
      roleAssignments: { retailer: 'p1', wholesaler: 'p2', distributor: 'p3', factory: 'p4' },
      rules: {
        objective: 'Minimize your team total holding and backlog cost.',
        holdingCost: 0.5,
        backlogCost: 1,
        orderDelayWeeks: 2,
        shippingDelayWeeks: 2,
        factoryRequestDelayWeeks: 1,
        factoryProductionDelayWeeks: 2,
        warmupWeeks: 4,
        initialInventory: 12,
        initialPipelineQuantity: 4,
        totalRotations: 4,
        weeksPerRotation: 50,
        roleChain: ['retailer', 'wholesaler', 'distributor', 'factory'],
        maximumOrder: maxBeerOrder(config.beer),
      },
      inventory: 12,
      backlog: 0,
      incomingOrder: 4,
      incomingShipment: 4,
      shipped: 4,
      weeklyCost: 6,
      cumulativeCost: 6,
      submitted: false,
    });
    expect(JSON.stringify(beerView(state, 'p2', config.beer))).not.toMatch(
      /incomingOrders|incomingShipments|factoryRequests|demandPack|"demand"|"pending"|games/,
    );
  });
  it('waits for all eight hidden orders and rejects invalid warmup input without mutation', () => {
    const start = createBeer(['p1', 'p5'], teams, config.beer);
    const seven = orderAll(start, 7);
    expect(seven.week).toBe(1);
    expect(Object.keys(seven.pending)).toHaveLength(7);
    expect(beerView(seven, 'p1', config.beer)).toMatchObject({
      submitted: true,
      submittedOrder: 4,
    });
    expect(beerView(seven, 'p8', config.beer)).not.toHaveProperty('submittedOrder');
    expect(beerView(seven, 'p8', config.beer).cumulativeCost).toBe(6);
    const applied = applyBeerOrder(seven, 'p8', 4, config.beer);
    expect(applied.state).toMatchObject({ week: 2, pending: {} });
    expect(beerView(applied.state, 'p1', config.beer).cumulativeCost).toBe(12);
    expect(applied.effects.map((effect) => effect.kind)).toEqual(['beer_order', 'beer_week']);
    const before = structuredClone(start);
    expect(() => applyBeerOrder(start, 'p1', 5, config.beer)).toThrow(/warmup/i);
    expect(start).toEqual(before);
  });
  it('shows the latest completed result for only the player’s own team', () => {
    let state = createBeer(['p1', 'p5'], teams, config.beer);
    for (let week = 0; week < 50; week += 1) state = orderAll(state);
    const view = beerView(state, 'p1', config.beer);
    expect(view).toMatchObject({ rotation: 2, week: 1 });
    const result = state.results.find(({ rotation, teamId }) => rotation === 1 && teamId === 'p1')!;
    expect(result).not.toHaveProperty('totalCost');
    expect(view.previousRotationResult).toEqual({ ...result, totalCost: beerRotationCost(result) });
    expect(view.previousRotationResult!.costByPlayer).toEqual(
      Object.fromEntries(teams.p1!.map((id) => [id, expect.any(Number)])),
    );
    expect(view.previousRotationResult!.costByPlayer).not.toHaveProperty('p5');
  });
  it('derives and enforces a safe order maximum from the fixed numerical horizon', () => {
    const maximum = maxBeerOrder(config.beer);
    expect(Number.isSafeInteger(maximum)).toBe(true);
    expect(maximum).toBeGreaterThan(config.beer.initialPipelineQuantity);
    const higherCost = structuredClone(config.beer);
    higherCost.backlogCost *= 2;
    const longerDelays = structuredClone(config.beer);
    longerDelays.orderDelayWeeks *= 2;
    expect(maxBeerOrder(higherCost)).toBeLessThan(maximum);
    expect(maxBeerOrder(longerDelays)).toBeLessThan(maximum);
    let state = createBeer(['p1', 'p5'], teams, config.beer);
    for (let week = 0; week < config.beer.warmupWeeks; week += 1) state = orderAll(state);
    const before = structuredClone(state);
    expect(() => applyBeerOrder(state, 'p1', maximum + 1, config.beer)).toThrow(/maximum/i);
    expect(state).toEqual(before);
    expect(applyBeerOrder(state, 'p1', maximum, config.beer).state.pending.p1).toBe(maximum);
    let full = createBeer(['p1', 'p5'], teams, config.beer);
    while (!beerComplete(full)) {
      const playerId = players.find((id) => full.pending[id] === undefined)!;
      const quantity = full.week <= config.beer.warmupWeeks ? 4 : maximum;
      full = applyBeerOrder(full, playerId, quantity, config.beer).state;
    }
    expect(full.results).toHaveLength(8);
    expect(
      full.results.every(
        (result) =>
          Number.isFinite(beerRotationCost(result)) &&
          beerRotationCost(result) <= Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(true);
    const unsafeRules = structuredClone(config.beer);
    unsafeRules.demand[0]![49] = maximum + 1;
    expect(() => createBeer(['p1', 'p5'], teams, unsafeRules)).toThrow(/safe quantity/i);
  });
});
describe('tournament transitions', () => {
  it('preserves the complete deterministic public benchmark result', async () => {
    const completed = finishTournament(await loadConfig('configs/benchmark.json'));
    expect(completed.counts).toEqual({ poker_a: 8, draft: 7, beer: 1600, poker_b: 8 });
    expect(sha256(completed.result)).toBe(
      'c72922364bd431ce574d30a1385e5269eccb8afce12ffb49b2fc29576670ebca',
    );
  });
  it('round-trips all eight prototype-like player IDs through the complete tournament', async () => {
    const gameConfig = await loadConfig('configs/benchmark.json');
    const ids = [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
    ];
    gameConfig.players = ids.map((id) => ({ id, publicBiography: id }));
    const completed = finishTournament(gameConfig);
    expect(completed.counts).toEqual({ poker_a: 8, draft: 7, beer: 1600, poker_b: 8 });
    for (const poker of [completed.result.pokerA, completed.result.pokerB]) {
      expect(Object.keys(poker.placements).toSorted()).toEqual(ids.toSorted());
      expect(poker.scores).toHaveLength(8);
    }
    expect(completed.result.pokerB.winner).toBe('toString');
    expect(completed.result.pokerB.scores).toContainEqual({
      playerId: 'toString',
      place: 1,
      score: 8,
    });
    expect(Object.keys(completed.result.beer.costByPlayer).toSorted()).toEqual(ids.toSorted());
    expect(completed.result.beer.rotations).toHaveLength(8);
    expect(completed.result.reward).toBe(8);
  });
  it('lets only the Poker A winner choose the opponent, then drafts alternating 4-4 teams', () => {
    let state: TournamentState = {
      version: 1,
      stage: 'draft',
      draft: { winner: 'p1', teams: {}, available: players.slice(1) },
    };
    const history = { pokerA: pokerResult() };
    expect(tournamentStatus(state, config, 'p1', history).canSendMessage).toBe(true);
    expect(tournamentStatus(state, config, 'p1', history).view).toMatchObject({
      pokerAResult: { winner: 'p1' },
    });
    expect(tournamentActions(state, config, 'p2')).toEqual([]);
    expect(tournamentActions(state, config, 'p1').map(({ actionId }) => actionId)).toContain(
      'draft.choose_captain',
    );
    state = applyTournament(state, config, 'p1', {
      actionId: 'draft.choose_captain',
      parameters: { playerId: 'p5' },
    }).state;
    if (state.stage !== 'draft') throw new Error('Expected draft.');
    expect(state.draft.captains).toEqual(['p1', 'p5']);
    const turns: string[] = [];
    while (state.stage === 'draft') {
      const captain: PlayerId = state.draft.nextCaptain!;
      turns.push(captain);
      const choice: ReturnType<typeof tournamentActions>[number] = tournamentActions(
        state,
        config,
        captain,
      )[0]!;
      const playerId: PlayerId = (choice.parameters!.playerId as { choices: string[] }).choices[0]!;
      state = applyTournament(state, config, captain, {
        actionId: 'draft.pick',
        parameters: { playerId },
      }).state;
    }
    if (state.stage !== 'beer') throw new Error('Expected Beer.');
    expect(state).not.toHaveProperty('draft');
    expect(Object.values(state.beer.teams).map((team) => team.length)).toEqual([4, 4]);
    expect(turns.every((captain, index) => !index || captain !== turns[index - 1])).toBe(true);
    expect(beerView(state.beer, state.beer.captains[0]!, config.beer).role).toBe('retailer');
    expect(tournamentStatus(state, config, 'p1')).toMatchObject({
      canSendMessage: false,
      actionRequired: true,
      view: { pokerBReward: { lowerTotalCostWins: true, winningPlayerStackMultiplier: 1.25 } },
    });
    expect(tournamentActions(state, config, 'p1')[0]).toMatchObject({
      actionId: 'beer.order',
      parameters: { quantity: { required: true, exact: 4 } },
      exampleParameters: { quantity: 4 },
    });
  });
  it('awards both teams on an exact Beer tie and derives 9-place poker scores', () => {
    const [beer, openingRoles] = beerBeforeFinal();
    expect(openingRoles).toEqual(['retailer', 'factory', 'distributor', 'wholesaler']);
    const invalidConfig = structuredClone(config);
    invalidConfig.poker.finalWinnerStackMultiplier = 1.001;
    expect(() => finishBeer(beer, invalidConfig)).toThrow(/integer stack/i);
    const transition = finishBeer(beer);
    if (transition.state.stage !== 'poker_b') throw new Error('Expected Poker B.');
    expect(transition.state).not.toHaveProperty('beer');
    const milestone = transition.effects.find(({ kind }) => kind === 'milestone')!;
    const history = tournamentHistory([
      { stage: 'draft', pokerResult: pokerResult() },
      milestone.data,
    ]);
    if (!history.beer) throw new Error('Expected Beer history.');
    expect(history.beer).not.toHaveProperty('games');
    expect(transition.state.poker.initialChipTotal).toBe(8 * 125);
    expect(transition.state.poker.hand!.startingStacks).toEqual(
      Object.fromEntries(players.map((id) => [id, 125])),
    );
    expect(tournamentStatus(transition.state, config, 'p1', history).view).toMatchObject({
      tournamentRules: { scoreFormula: '9 - final place' },
      beerOutcome: { winningTeamIds: ['p1', 'p5'] },
    });
    expect(() => tournamentStatus(transition.state, config, 'p1')).toThrow(/milestone/i);
    const second = pokerResult([...players].reverse());
    const result = tournamentResult(
      tournamentHistory([
        { stage: 'draft', pokerResult: pokerResult() },
        milestone.data,
        { stage: 'complete', pokerResult: second },
      ]),
    );
    expect(result!.beer.winningTeamIds).toEqual(['p1', 'p5']);
    expect(result!.beer.bonusPlayerIds).toHaveLength(8);
    expect(result!.pokerA.scores).toContainEqual({ playerId: 'p1', place: 1, score: 8 });
    expect(result!.pokerA.placeGroups.flatMap(({ playerIds }) => playerIds)).toHaveLength(8);
    expect(result!.pokerB.scores).toContainEqual({ playerId: 'p8', place: 1, score: 8 });
    expect(result!.reward).toBe(8);
  });
  it('boosts only the four players on the unequal lower-cost Beer team', () => {
    const [beer] = beerBeforeFinal((state, id) =>
      state.week <= config.beer.warmupWeeks || teams.p5!.includes(id) ? 4 : 0,
    );
    const transition = finishBeer(beer);
    if (transition.state.stage !== 'poker_b') throw new Error('Expected Poker B.');
    expect(transition.state.poker.hand!.startingStacks).toEqual(
      Object.fromEntries(players.map((id) => [id, teams.p5!.includes(id) ? 125 : 100])),
    );
  });
});
