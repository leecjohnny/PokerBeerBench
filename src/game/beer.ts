import { roles, type BenchmarkConfig, type PlayerId, type Role } from '../shared.js';
export type Assignment = Readonly<Record<Role, PlayerId>>;
export type BeerRoleState = {
  inventory: number;
  backlog: number;
  incomingOrders: number[];
  incomingShipments: number[];
  cumulativeCost: number;
  receivedOrder: number;
  receivedShipment: number;
  shipped: number;
  previousOrder?: number;
};
type TeamGame = { roles: Record<Role, BeerRoleState>; factoryRequests: number[] };
export type BeerRotationResult = {
  rotation: number;
  teamId: PlayerId;
  costByPlayer: Record<PlayerId, number>;
};
export type BeerPublicRotationResult = BeerRotationResult & { totalCost: number };
export type BeerState = {
  captains: readonly [PlayerId, PlayerId];
  teams: Record<PlayerId, PlayerId[]>;
  rotation: number;
  week: number;
  games: Record<PlayerId, TeamGame>;
  pending: Record<PlayerId, number>;
  results: BeerRotationResult[];
};
export type BeerOutcome = {
  captains: readonly [PlayerId, PlayerId];
  teams: Record<PlayerId, PlayerId[]>;
  results: BeerRotationResult[];
};
export type BeerPublicRules = {
  objective: string;
  holdingCost: number;
  backlogCost: number;
  orderDelayWeeks: number;
  shippingDelayWeeks: number;
  factoryRequestDelayWeeks: number;
  factoryProductionDelayWeeks: number;
  warmupWeeks: number;
  initialInventory: number;
  initialPipelineQuantity: number;
  totalRotations: 4;
  weeksPerRotation: 50;
  roleChain: readonly Role[];
  maximumOrder: number;
};
export type BeerView = {
  rotation: number;
  rotations: 4;
  week: number;
  weeks: 50;
  teamId: PlayerId;
  teamPlayerIds: PlayerId[];
  role: Role;
  roleAssignments: Assignment;
  rules: BeerPublicRules;
  inventory: number;
  backlog: number;
  incomingOrder: number;
  incomingShipment: number;
  shipped: number;
  weeklyCost: number;
  cumulativeCost: number;
  previousOrder?: number;
  submitted: boolean;
  submittedOrder?: number;
  previousRotationResult?: BeerPublicRotationResult;
};
export type BeerEffect = {
  kind: 'beer_order' | 'beer_week' | 'beer_rotation';
  data: Record<string, unknown>;
};
const upstream: Record<Role, Role | null> = {
    retailer: 'wholesaler',
    wholesaler: 'distributor',
    distributor: 'factory',
    factory: null,
  },
  totalRotations = 4,
  weeksPerRotation = 50;
export const beerComplete = (state: BeerState): boolean => state.results.length === 8;
export const beerRotationCost = (result: BeerRotationResult): number =>
  Object.values(result.costByPlayer).reduce((sum, value) => sum + value, 0);
export function maxBeerOrder(rules: BenchmarkConfig['beer']): number {
  const delayedPipelineSlots =
    3 * (rules.orderDelayWeeks + rules.shippingDelayWeeks) +
    rules.factoryRequestDelayWeeks +
    rules.factoryProductionDelayWeeks;
  const events =
    roles.length * weeksPerRotation + weeksPerRotation + roles.length + delayedPipelineSlots;
  const costs =
    totalRotations *
    roles.length *
    weeksPerRotation *
    Math.max(1, rules.holdingCost, rules.backlogCost);
  return Math.max(0, Math.floor(Number.MAX_SAFE_INTEGER / events / costs));
}
function validateRules(rules: BenchmarkConfig['beer'], maximumOrder: number): void {
  const configuredQuantities = [
    rules.initialInventory,
    rules.initialPipelineQuantity,
    ...rules.demand.flat(),
  ];
  if (configuredQuantities.some((value) => value > maximumOrder))
    throw new Error(`Beer rules exceed safe quantity maximum ${maximumOrder}.`);
}
const qty = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Beer quantity.');
  return value;
};
const cost = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid Beer cost.');
  return value;
};
const pop = (line: number[]): [number, number[]] => [line[0] ?? 0, [...line.slice(1), 0]];
const push = (line: number[], value: number): number[] => [...line.slice(0, -1), value];
export function deriveAssignments(team: readonly PlayerId[]): Assignment[] {
  if (team.length !== 4 || new Set(team).size !== 4) throw new Error('Invalid Beer team.');
  return roles.map((_, rotation) =>
    Object.fromEntries(roles.map((role, index) => [role, team[(index + rotation) % 4]!])),
  ) as Assignment[];
}
function prepare(game: TeamGame, demand: number, rules: BenchmarkConfig['beer']): TeamGame {
  const next = {} as Record<Role, BeerRoleState>;
  const shipped = {} as Record<Role, number>;
  for (const role of roles) {
    const old = game.roles[role];
    const [receivedShipment, incomingShipments] = pop(old.incomingShipments);
    const [receivedOrder, incomingOrders] =
      role === 'retailer' ? [demand, []] : pop(old.incomingOrders);
    const available = qty(old.inventory + receivedShipment);
    const owed = qty(old.backlog + receivedOrder);
    const sent = Math.min(available, owed);
    const inventory = available - sent;
    const backlog = owed - sent;
    const weeklyCost = cost(inventory * rules.holdingCost + backlog * rules.backlogCost);
    shipped[role] = sent;
    next[role] = {
      ...old,
      inventory,
      backlog,
      incomingOrders,
      incomingShipments,
      cumulativeCost: cost(old.cumulativeCost + weeklyCost),
      receivedOrder,
      receivedShipment,
      shipped: sent,
    };
  }
  for (const role of roles) {
    const supplier = upstream[role];
    if (supplier)
      next[role].incomingShipments = push(next[role].incomingShipments, shipped[supplier]);
  }
  const [production, factoryRequests] = pop(game.factoryRequests);
  next.factory.incomingShipments = push(next.factory.incomingShipments, production);
  return { roles: next, factoryRequests };
}
function fresh(rules: BenchmarkConfig['beer'], demand: number): TeamGame {
  const roleStates = {} as Record<Role, BeerRoleState>;
  for (const role of roles) {
    const incomingOrders =
      role === 'retailer' ? [] : Array(rules.orderDelayWeeks).fill(rules.initialPipelineQuantity);
    const delay = role === 'factory' ? rules.factoryProductionDelayWeeks : rules.shippingDelayWeeks;
    roleStates[role] = {
      inventory: rules.initialInventory,
      backlog: 0,
      incomingOrders,
      incomingShipments: Array(delay).fill(rules.initialPipelineQuantity),
      cumulativeCost: 0,
      receivedOrder: 0,
      receivedShipment: 0,
      shipped: 0,
    };
  }
  const factoryRequests = Array(rules.factoryRequestDelayWeeks).fill(rules.initialPipelineQuantity);
  return prepare({ roles: roleStates, factoryRequests }, demand, rules);
}
function assignment(state: BeerState, captain: PlayerId): Assignment {
  return deriveAssignments(state.teams[captain]!)[state.rotation - 1]!;
}
export function createBeer(
  captains: readonly [PlayerId, PlayerId],
  teams: Record<PlayerId, PlayerId[]>,
  rules: BenchmarkConfig['beer'],
): BeerState {
  validateRules(rules, maxBeerOrder(rules));
  const games = Object.fromEntries(
    captains.map((captain) => [captain, fresh(rules, rules.demand[0]![0]!)]),
  );
  return { captains, teams, rotation: 1, week: 1, games, pending: {}, results: [] };
}
function seat(state: BeerState, playerId: PlayerId): [PlayerId, Role] {
  const captain = state.captains.find((id) => state.teams[id]!.includes(playerId));
  const role = captain && roles.find((name) => assignment(state, captain)[name] === playerId);
  if (!captain || !role) throw new Error('Player is not assigned to Beer.');
  return [captain, role];
}
export function beerView(
  state: BeerState,
  playerId: PlayerId,
  beerRules: BenchmarkConfig['beer'],
): BeerView {
  const [teamId, role] = seat(state, playerId);
  const value = state.games[teamId]!.roles[role];
  const previous = 'previousOrder' in value ? { previousOrder: value.previousOrder } : {};
  const submittedOrder = Object.hasOwn(state.pending, playerId)
    ? state.pending[playerId]
    : undefined;
  const submitted = submittedOrder !== undefined ? { submittedOrder } : {};
  const previousRotationResult = [...state.results]
    .reverse()
    .find((result) => result.teamId === teamId);
  const priorResult = previousRotationResult
    ? {
        previousRotationResult: {
          ...previousRotationResult,
          totalCost: beerRotationCost(previousRotationResult),
          costByPlayer: { ...previousRotationResult.costByPlayer },
        },
      }
    : {};
  const roleAssignments = assignment(state, teamId);
  const rules: BeerPublicRules = {
    objective: 'Minimize your team total holding and backlog cost.',
    holdingCost: beerRules.holdingCost,
    backlogCost: beerRules.backlogCost,
    orderDelayWeeks: beerRules.orderDelayWeeks,
    shippingDelayWeeks: beerRules.shippingDelayWeeks,
    factoryRequestDelayWeeks: beerRules.factoryRequestDelayWeeks,
    factoryProductionDelayWeeks: beerRules.factoryProductionDelayWeeks,
    warmupWeeks: beerRules.warmupWeeks,
    initialInventory: beerRules.initialInventory,
    initialPipelineQuantity: beerRules.initialPipelineQuantity,
    totalRotations,
    weeksPerRotation,
    roleChain: [...roles],
    maximumOrder: maxBeerOrder(beerRules),
  };
  const weeklyCost =
    value.inventory * beerRules.holdingCost + value.backlog * beerRules.backlogCost;
  return {
    rotation: state.rotation,
    rotations: totalRotations,
    week: state.week,
    weeks: weeksPerRotation,
    teamId,
    teamPlayerIds: [...state.teams[teamId]!],
    role,
    roleAssignments,
    rules,
    inventory: value.inventory,
    backlog: value.backlog,
    incomingOrder: value.receivedOrder,
    incomingShipment: value.receivedShipment,
    shipped: value.shipped,
    weeklyCost,
    cumulativeCost: value.cumulativeCost,
    ...previous,
    submitted: submittedOrder !== undefined,
    ...submitted,
    ...priorResult,
  };
}
function commit(
  game: TeamGame,
  assignment: Assignment,
  orders: Record<PlayerId, number>,
): TeamGame {
  const next = Object.fromEntries(
    roles.map((role) => [role, { ...game.roles[role], previousOrder: orders[assignment[role]]! }]),
  ) as Record<Role, BeerRoleState>;
  for (const role of roles) {
    const supplier = upstream[role];
    if (supplier)
      next[supplier].incomingOrders = push(
        next[supplier].incomingOrders,
        orders[assignment[role]]!,
      );
  }
  return { roles: next, factoryRequests: push(game.factoryRequests, orders[assignment.factory]!) };
}
export function applyBeerOrder(
  state: BeerState,
  playerId: PlayerId,
  quantity: number,
  rules: BenchmarkConfig['beer'],
): { state: BeerState; effects: BeerEffect[] } {
  if (beerComplete(state) || Object.hasOwn(state.pending, playerId))
    throw new Error('Beer order is unavailable.');
  qty(quantity);
  const maximumOrder = maxBeerOrder(rules);
  if (quantity > maximumOrder) throw new Error(`Beer order exceeds maximum ${maximumOrder}.`);
  if (state.week <= rules.warmupWeeks && quantity !== rules.initialPipelineQuantity)
    throw new Error(`Warmup requires order ${rules.initialPipelineQuantity}.`);
  const [teamId, role] = seat(state, playerId);
  const pending = { ...state.pending, [playerId]: quantity };
  const effects: BeerEffect[] = [
    {
      kind: 'beer_order',
      data: { playerId, teamId, role, rotation: state.rotation, week: state.week, quantity },
    },
  ];
  if (Object.keys(pending).length < 8) return { state: { ...state, pending }, effects };
  const games = Object.fromEntries(
    state.captains.map((captain) => [
      captain,
      commit(state.games[captain]!, assignment(state, captain), pending),
    ]),
  ) as Record<PlayerId, TeamGame>;
  effects.push({
    kind: 'beer_week',
    data: {
      rotation: state.rotation,
      week: state.week,
      demand: rules.demand[state.rotation - 1]![state.week - 1],
      teams: games,
    },
  });
  if (state.week < 50) {
    const demand = rules.demand[state.rotation - 1]![state.week]!;
    const prepared = Object.fromEntries(
      state.captains.map((captain) => [captain, prepare(games[captain]!, demand, rules)]),
    );
    return { state: { ...state, week: state.week + 1, games: prepared, pending: {} }, effects };
  }
  const rotationResults = state.captains.map((captain) => {
    const rolesByPlayer = assignment(state, captain);
    const costs = Object.fromEntries(
      roles.map((name) => [rolesByPlayer[name], games[captain]!.roles[name].cumulativeCost]),
    );
    return { rotation: state.rotation, teamId: captain, costByPlayer: costs };
  });
  const results = [...state.results, ...rotationResults];
  effects.push({
    kind: 'beer_rotation',
    data: { rotation: state.rotation, results: rotationResults },
  });
  if (state.rotation === 4) return { state: { ...state, games, pending: {}, results }, effects };
  const rotation = state.rotation + 1;
  const freshGames = Object.fromEntries(
    state.captains.map((captain) => [captain, fresh(rules, rules.demand[rotation - 1]![0]!)]),
  );
  return {
    state: { ...state, rotation, week: 1, games: freshGames, pending: {}, results },
    effects,
  };
}
