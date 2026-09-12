import { createHmac } from 'node:crypto';
import { clone, type PlayerId } from '../shared.js';
export const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const suits = ['c', 'd', 'h', 's'] as const;
export type Card = `${(typeof ranks)[number]}${(typeof suits)[number]}`;
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type BlindLevel = readonly [
  smallBlind: number,
  bigBlind: number,
  bigBlindAnte: number,
  hands: number,
];
export type PokerRules = { readonly blindSchedule: readonly BlindLevel[] };
export type PokerAction =
  | { readonly id: 'fold' | 'check' | 'call' | 'all_in' }
  | { readonly id: 'bet' | 'raise'; readonly to: number };
export type PokerActionOption =
  | { readonly id: 'fold' | 'check' }
  | { readonly id: 'call'; readonly amount: number; readonly allIn: boolean }
  | { readonly id: 'bet' | 'raise'; readonly minTo: number; readonly maxTo: number }
  | { readonly id: 'all_in'; readonly to: number; readonly fullRaise: boolean };
export type PokerPublicAction = {
  readonly street: Street;
  readonly actor: PlayerId;
  readonly action: PokerAction;
  readonly contributed: number;
  readonly stackAfter: number;
  readonly potAfter: number;
  readonly fullRaise: boolean;
};
export type PokerHandRank = {
  readonly category:
    | 'high_card'
    | 'pair'
    | 'two_pair'
    | 'three_of_a_kind'
    | 'straight'
    | 'flush'
    | 'full_house'
    | 'four_of_a_kind'
    | 'straight_flush';
  readonly tie: readonly number[];
  readonly cards: readonly Card[];
};
export type PokerSeat = { readonly playerId: PlayerId; stack: number };
export type PokerElimination = {
  readonly playerId: PlayerId;
  readonly hand: number;
  readonly place: number;
  readonly chipsAtHandStart: number;
};
export type PokerHand = {
  number: number;
  buttonSeat: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number;
  players: PlayerId[];
  startingStacks: Record<PlayerId, number>;
  deck: Card[];
  deckIndex: number;
  hole: Record<PlayerId, Card[]>;
  board: Card[];
  burns: Card[];
  street: Street;
  actor: PlayerId | null;
  folded: PlayerId[];
  streetPut: Record<PlayerId, number>;
  livePut: Record<PlayerId, number>;
  deadPut: Record<PlayerId, number>;
  actedAtBet: Record<PlayerId, number>;
  currentBet: number;
  minRaise: number;
  actionHistory: PokerPublicAction[];
};
export type PokerState = {
  readonly version: 1;
  readonly seed: string;
  readonly rules: { blindSchedule: BlindLevel[] };
  readonly initialChipTotal: number;
  seats: PokerSeat[];
  handsCompleted: number;
  lastBigBlindSeat: number;
  hand: PokerHand | null;
  eliminations: PokerElimination[];
  lastHand: PokerLastHand | null;
};
export type PokerPot = {
  readonly amount: number;
  readonly eligible: readonly PlayerId[];
  readonly awards: readonly { readonly playerId: PlayerId; readonly amount: number }[];
};
export type PokerLastHand = {
  readonly handNumber: number;
  readonly board: readonly Card[];
  readonly actionHistory: readonly PokerPublicAction[];
  readonly pots: readonly PokerPot[];
  readonly refunds: readonly { readonly playerId: PlayerId; readonly amount: number }[];
  readonly endingStacks: Readonly<Record<PlayerId, number>>;
  readonly eliminations: readonly PokerElimination[];
  readonly showdownRanks: Readonly<Record<PlayerId, PokerHandRank>>;
  readonly revealedHoleCards: Readonly<Record<PlayerId, readonly Card[]>>;
};
export type PokerLevelView = {
  readonly number: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly bigBlindAnte: number;
  readonly handsInLevel: number;
  readonly handsRemaining: number;
};
export type PokerEffect =
  | {
      readonly kind: 'poker_action';
      readonly hand: number;
      readonly street: Street;
      readonly actor: PlayerId;
      readonly action: PokerAction;
      readonly contributed: number;
      readonly stackAfter: number;
      readonly potAfter: number;
      readonly fullRaise: boolean;
    }
  | {
      readonly kind: 'poker_hand_finished';
      readonly hand: number;
      readonly level: BlindLevel;
      readonly deckSeed: string;
      readonly buttonSeat: number;
      readonly smallBlindSeat: number | null;
      readonly bigBlindSeat: number;
      readonly startingStacks: Readonly<Record<PlayerId, number>>;
      readonly endingStacks: Readonly<Record<PlayerId, number>>;
      readonly liveContributions: Readonly<Record<PlayerId, number>>;
      readonly deadContributions: Readonly<Record<PlayerId, number>>;
      readonly holeCards: Readonly<Record<PlayerId, readonly Card[]>>;
      readonly board: readonly Card[];
      readonly burns: readonly Card[];
      readonly refunds: readonly { readonly playerId: PlayerId; readonly amount: number }[];
      readonly pots: readonly PokerPot[];
      readonly showdown: Readonly<Record<PlayerId, PokerHandRank>>;
      readonly eliminations: readonly PokerElimination[];
    };
export type PokerResult = {
  readonly winner: PlayerId;
  readonly handsPlayed: number;
  readonly stacks: Readonly<Record<PlayerId, number>>;
  readonly placements: Readonly<Record<PlayerId, number>>;
  readonly totalChips: number;
  readonly lastHand?: PokerLastHand;
};
export type PokerView = {
  readonly handNumber: number;
  readonly street: Street | 'complete';
  readonly actor: PlayerId | null;
  readonly level: PokerLevelView;
  readonly buttonSeat: number | null;
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number | null;
  readonly board: readonly Card[];
  readonly pot: number;
  readonly currentBet: number;
  readonly minRaise: number;
  readonly actionHistory: readonly PokerPublicAction[];
  readonly seats: readonly {
    readonly seat: number;
    readonly playerId: PlayerId;
    readonly stack: number;
    readonly streetContribution: number;
    readonly handContribution: number;
    readonly status: 'active' | 'folded' | 'all_in' | 'eliminated';
    readonly elimination?: PokerElimination;
  }[];
  readonly ownHoleCards: readonly Card[] | null;
  readonly lastHand: PokerLastHand | null;
};
const values: Readonly<Record<string, number>> = Object.fromEntries(
  ranks.map((rank, index) => [rank, index + 2]),
);
function shuffled<T>(items: readonly T[], seed: string): T[] {
  return items
    .map((item, index) => ({
      item,
      key: createHmac('sha256', seed).update(String(index)).digest(),
    }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map(({ item }) => item);
}
export function shuffledDeck(seed: string): Card[] {
  return shuffled(
    suits.flatMap((suit) => ranks.map((rank) => `${rank}${suit}` as Card)),
    seed,
  );
}
function compareTie(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function straightHigh(input: readonly number[]): number | null {
  const unique = [...new Set(input)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const high = unique[index]!;
    if ([0, 1, 2, 3, 4].every((offset) => unique[index + offset] === high - offset)) return high;
  }
  return null;
}
function evaluateFive(cards: readonly Card[]): PokerHandRank {
  const cardValues = cards.map((card) => values[card[0]!]!);
  const counts = new Map<number, number>();
  for (const value of cardValues) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts].sort(([av, ac], [bv, bc]) => bc - ac || bv - av);
  const trips = groups.filter(([, count]) => count === 3).map(([value]) => value);
  const pairs = groups.filter(([, count]) => count === 2).map(([value]) => value);
  const singles = groups.filter(([, count]) => count === 1).map(([value]) => value);
  const flush = cards.every((card) => card[1] === cards[0]![1]);
  const straight = straightHigh(cardValues);
  let category: PokerHandRank['category'];
  let tie: number[];
  if (flush && straight !== null) [category, tie] = ['straight_flush', [8, straight]];
  else if (groups[0]?.[1] === 4)
    [category, tie] = ['four_of_a_kind', [7, groups[0][0], singles[0]!]];
  else if (trips.length && (pairs.length || trips.length > 1))
    [category, tie] = ['full_house', [6, trips[0]!, Math.max(pairs[0] ?? 0, trips[1] ?? 0)]];
  else if (flush) [category, tie] = ['flush', [5, ...cardValues.toSorted((a, b) => b - a)]];
  else if (straight !== null) [category, tie] = ['straight', [4, straight]];
  else if (trips.length) [category, tie] = ['three_of_a_kind', [3, trips[0]!, ...singles]];
  else if (pairs.length > 1) [category, tie] = ['two_pair', [2, pairs[0]!, pairs[1]!, singles[0]!]];
  else if (pairs.length) [category, tie] = ['pair', [1, pairs[0]!, ...singles]];
  else [category, tie] = ['high_card', [0, ...cardValues.toSorted((a, b) => b - a)]];
  return { category, tie, cards: [...cards] };
}
export function comparePokerHands(left: PokerHandRank, right: PokerHandRank): number {
  return compareTie(left.tie, right.tie);
}
export function evaluateHoldem(cards: readonly Card[]): PokerHandRank {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length)
    throw new Error('Holdem requires five through seven unique cards.');
  let best: PokerHandRank | null = null;
  for (let a = 0; a < cards.length - 4; a += 1)
    for (let b = a + 1; b < cards.length - 3; b += 1)
      for (let c = b + 1; c < cards.length - 2; c += 1)
        for (let d = c + 1; d < cards.length - 1; d += 1)
          for (let e = d + 1; e < cards.length; e += 1) {
            const hand = evaluateFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || comparePokerHands(hand, best) > 0) best = hand;
          }
  return best!;
}
function integer(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error(`${label} is invalid.`);
}
function levelProgress(state: PokerState): {
  level: BlindLevel;
  number: number;
  handsRemaining: number;
} {
  let remaining = state.handsCompleted;
  for (const [index, blindLevel] of state.rules.blindSchedule.entries()) {
    if (remaining < blindLevel[3] || index === state.rules.blindSchedule.length - 1)
      return {
        level: blindLevel,
        number: index + 1,
        handsRemaining: Math.max(0, blindLevel[3] - remaining),
      };
    remaining -= blindLevel[3];
  }
  throw new Error('Poker has no blind level.');
}
function level(state: PokerState): BlindLevel {
  return levelProgress(state).level;
}
function levelView(state: PokerState): PokerLevelView {
  const { level: current, number, handsRemaining } = levelProgress(state);
  return {
    number,
    smallBlind: current[0],
    bigBlind: current[1],
    bigBlindAnte: current[2],
    handsInLevel: current[3],
    handsRemaining,
  };
}
function seat(state: PokerState, playerId: PlayerId): PokerSeat {
  const found = state.seats.find((item) => item.playerId === playerId);
  if (!found) throw new Error(`Unknown poker player ${playerId}.`);
  return found;
}
function seatIndex(state: PokerState, playerId: PlayerId): number {
  const index = state.seats.findIndex((item) => item.playerId === playerId);
  if (index < 0) throw new Error(`Unknown poker player ${playerId}.`);
  return index;
}
function nextSeat(
  state: PokerState,
  from: number,
  accepts: (seat: PokerSeat) => boolean,
): number | null {
  for (let offset = 1; offset <= state.seats.length; offset += 1) {
    const index = (from + offset) % state.seats.length;
    if (accepts(state.seats[index]!)) return index;
  }
  return null;
}
function stacks(state: PokerState): Record<PlayerId, number> {
  return Object.fromEntries(state.seats.map((item) => [item.playerId, item.stack]));
}
function zeros(players: readonly PlayerId[]): Record<PlayerId, number> {
  return Object.fromEntries(players.map((playerId) => [playerId, 0]));
}
function pot(state: PokerState): number {
  return state.hand
    ? [...Object.values(state.hand.livePut), ...Object.values(state.hand.deadPut)].reduce(
        (sum, amount) => sum + amount,
        0,
      )
    : 0;
}
function commit(state: PokerState, playerId: PlayerId, requested: number, dead = false): number {
  integer(requested, 'Poker contribution');
  const player = seat(state, playerId);
  const paid = Math.min(player.stack, requested);
  player.stack -= paid;
  const hand = state.hand!;
  const contributions = dead ? hand.deadPut : hand.livePut;
  contributions[playerId] = (contributions[playerId] ?? 0) + paid;
  if (!dead) hand.streetPut[playerId] = (hand.streetPut[playerId] ?? 0) + paid;
  return paid;
}
function draw(hand: PokerHand): Card {
  const card = hand.deck[hand.deckIndex++];
  if (!card) throw new Error('Poker deck exhausted.');
  return card;
}
function playerNeedsAction(state: PokerState, playerId: PlayerId): boolean {
  const hand = state.hand!;
  if (hand.folded.includes(playerId) || seat(state, playerId).stack === 0) return false;
  return (
    !Object.hasOwn(hand.actedAtBet, playerId) || (hand.streetPut[playerId] ?? 0) < hand.currentBet
  );
}

function nextActor(state: PokerState, from: number): PlayerId | null {
  const hand = state.hand!;
  const index = nextSeat(
    state,
    from,
    (candidate) =>
      hand.players.includes(candidate.playerId) && playerNeedsAction(state, candidate.playerId),
  );
  return index === null ? null : state.seats[index]!.playerId;
}

function startHand(state: PokerState, initialButton?: number, effects?: PokerEffect[]): void {
  const active = state.seats.filter((item) => item.stack > 0);
  if (active.length <= 1) {
    state.hand = null;
    return;
  }
  let buttonSeat: number;
  let smallBlindSeat: number | null;
  let bigBlindSeat: number;
  if (initialButton !== undefined) {
    buttonSeat = initialButton;
    smallBlindSeat = nextSeat(state, buttonSeat, (candidate) => candidate.stack > 0)!;
    bigBlindSeat = nextSeat(state, smallBlindSeat, (candidate) => candidate.stack > 0)!;
  } else {
    bigBlindSeat = nextSeat(state, state.lastBigBlindSeat, (candidate) => candidate.stack > 0)!;
    if (active.length === 2) {
      const other = nextSeat(state, bigBlindSeat, (candidate) => candidate.stack > 0)!;
      buttonSeat = other;
      smallBlindSeat = other;
    } else {
      const physicalSmallBlind = (bigBlindSeat + state.seats.length - 1) % state.seats.length;
      smallBlindSeat = state.seats[physicalSmallBlind]!.stack > 0 ? physicalSmallBlind : null;
      buttonSeat = (bigBlindSeat + state.seats.length - 2) % state.seats.length;
    }
  }
  state.lastBigBlindSeat = bigBlindSeat;
  const players = state.seats.filter((item) => item.stack > 0).map((item) => item.playerId);
  const handNumber = state.handsCompleted + 1;
  const deck = shuffledDeck(`${state.seed}:hand:${handNumber}:deck`);
  state.hand = {
    number: handNumber,
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    players,
    startingStacks: stacks(state),
    deck,
    deckIndex: 0,
    hole: Object.fromEntries(players.map((playerId) => [playerId, []])),
    board: [],
    burns: [],
    street: 'preflop',
    actor: null,
    folded: [],
    streetPut: zeros(players),
    livePut: zeros(players),
    deadPut: zeros(players),
    actedAtBet: {},
    currentBet: 0,
    minRaise: level(state)[1],
    actionHistory: [],
  };
  const [, bigBlind, ante] = level(state);
  const bigBlindPlayer = state.seats[bigBlindSeat]!.playerId;
  commit(state, bigBlindPlayer, bigBlind);
  commit(state, bigBlindPlayer, ante, true);
  if (smallBlindSeat !== null)
    commit(state, state.seats[smallBlindSeat]!.playerId, level(state)[0]);
  state.hand.currentBet = bigBlind;
  let cursor = buttonSeat;
  for (let round = 0; round < 2; round += 1)
    for (let count = 0; count < players.length; count += 1) {
      cursor = nextSeat(state, cursor, (candidate) => players.includes(candidate.playerId))!;
      state.hand.hole[state.seats[cursor]!.playerId]!.push(draw(state.hand));
    }
  state.hand.actor = nextActor(state, bigBlindSeat);
  if (!state.hand.actor && effects) settle(state, effects);
}

export function createPoker(
  playerIds: readonly PlayerId[],
  startingStacks: Readonly<Record<PlayerId, number>>,
  rules: PokerRules,
  seed: string,
): PokerState {
  if (playerIds.length !== 8 || new Set(playerIds).size !== 8)
    throw new Error('Poker requires eight players.');
  if (!seed.trim() || rules.blindSchedule.length === 0)
    throw new Error('Poker rules are incomplete.');
  for (const [index, [smallBlind, bigBlind, ante, hands]] of rules.blindSchedule.entries()) {
    integer(smallBlind, `Small blind ${index}`);
    integer(bigBlind, `Big blind ${index}`, true);
    integer(ante, `Ante ${index}`);
    integer(hands, `Hands ${index}`, true);
    if (smallBlind >= bigBlind) throw new Error('Small blind must be below big blind.');
  }
  for (const playerId of playerIds)
    integer(startingStacks[playerId]!, `Stack for ${playerId}`, true);
  const seated = shuffled(playerIds, `${seed}:seats`);
  const state: PokerState = {
    version: 1,
    seed,
    rules: { blindSchedule: rules.blindSchedule.map((item) => [...item] as unknown as BlindLevel) },
    initialChipTotal: playerIds.reduce((sum, playerId) => sum + startingStacks[playerId]!, 0),
    seats: seated.map((playerId) => ({ playerId, stack: startingStacks[playerId]! })),
    handsCompleted: 0,
    lastBigBlindSeat: -1,
    hand: null,
    eliminations: [],
    lastHand: null,
  };
  startHand(state, shuffled([...state.seats.keys()], `${seed}:button`)[0]!);
  assertPoker(state);
  return state;
}

export function pokerActions(state: PokerState, playerId: PlayerId): readonly PokerActionOption[] {
  seat(state, playerId);
  const hand = state.hand;
  if (!hand || hand.actor !== playerId || !playerNeedsAction(state, playerId)) return [];
  const player = seat(state, playerId);
  const put = hand.streetPut[playerId] ?? 0;
  const call = Math.max(0, hand.currentBet - put);
  const allInTo = put + player.stack;
  const last = Object.hasOwn(hand.actedAtBet, playerId) ? hand.actedAtBet[playerId] : undefined;
  const reopened = last === undefined || last === 0 || hand.currentBet - last >= hand.minRaise;
  const opponentCanAct = hand.players.some(
    (other) => other !== playerId && !hand.folded.includes(other) && seat(state, other).stack > 0,
  );
  const options: PokerActionOption[] = [{ id: 'fold' }];
  if (call === 0) options.push({ id: 'check' });
  else
    options.push({ id: 'call', amount: Math.min(call, player.stack), allIn: player.stack <= call });
  if (opponentCanAct && hand.currentBet === 0 && player.stack >= level(state)[1])
    options.push({ id: 'bet', minTo: level(state)[1], maxTo: allInTo });
  else if (opponentCanAct && hand.currentBet > 0 && reopened) {
    const minTo = hand.currentBet + hand.minRaise;
    if (allInTo >= minTo) options.push({ id: 'raise', minTo, maxTo: allInTo });
  }
  const raises = allInTo > hand.currentBet;
  if (!raises || (opponentCanAct && reopened))
    options.push({
      id: 'all_in',
      to: allInTo,
      fullRaise: raises && allInTo - hand.currentBet >= hand.minRaise,
    });
  return options;
}

function dealStreet(hand: PokerHand): void {
  const next: Record<Exclude<Street, 'river'>, Street> = {
    preflop: 'flop',
    flop: 'turn',
    turn: 'river',
  };
  if (hand.street === 'river') throw new Error('Cannot deal beyond the river.');
  hand.street = next[hand.street];
  hand.burns.push(draw(hand));
  for (let count = 0; count < (hand.street === 'flop' ? 3 : 1); count += 1)
    hand.board.push(draw(hand));
  hand.streetPut = zeros(hand.players);
  hand.actedAtBet = {};
  hand.currentBet = 0;
}

function contenders(state: PokerState): PlayerId[] {
  return state.hand!.players.filter((playerId) => !state.hand!.folded.includes(playerId));
}

function awards(
  state: PokerState,
  amount: number,
  winners: readonly PlayerId[],
): { playerId: PlayerId; amount: number }[] {
  const button = state.hand!.buttonSeat;
  const ordered = [...winners].sort((left, right) => {
    const distance = (playerId: PlayerId) =>
      (seatIndex(state, playerId) - button + state.seats.length) % state.seats.length ||
      state.seats.length;
    return distance(left) - distance(right);
  });
  const share = Math.floor(amount / ordered.length);
  let odd = amount % ordered.length;
  return ordered.map((playerId) => {
    const award = share + (odd-- > 0 ? 1 : 0);
    seat(state, playerId).stack += award;
    return { playerId, amount: award };
  });
}

function settle(state: PokerState, effects: PokerEffect[]): void {
  const hand = state.hand!;
  const live = contenders(state);
  while (live.length > 1 && hand.board.length < 5) dealStreet(hand);
  const refunds: { playerId: PlayerId; amount: number }[] = [];
  const descending = Object.entries(hand.livePut).sort(([, a], [, b]) => b - a);
  if (descending[0] && descending[0][1] > (descending[1]?.[1] ?? 0)) {
    const [playerId, top] = descending[0];
    const amount = top - (descending[1]?.[1] ?? 0);
    hand.livePut[playerId] = top - amount;
    seat(state, playerId).stack += amount;
    refunds.push({ playerId, amount });
  }
  const showdown: Record<PlayerId, PokerHandRank> = Object.fromEntries(
    live.length > 1
      ? live.map((playerId) => [playerId, evaluateHoldem([...hand.hole[playerId]!, ...hand.board])])
      : [],
  );
  const pots: PokerPot[] = [];
  const levels = [...new Set(Object.values(hand.livePut).filter(Boolean))].sort((a, b) => a - b);
  const dead = Object.values(hand.deadPut).reduce((sum, amount) => sum + amount, 0);
  if (dead && !levels.length) levels.push(0);
  let previous = 0;
  for (const contribution of levels) {
    const contributors = hand.players.filter((playerId) => hand.livePut[playerId]! >= contribution);
    const amount = (contribution - previous) * contributors.length + (pots.length ? 0 : dead);
    previous = contribution;
    const eligible = contributors.filter((playerId) => live.includes(playerId));
    if (!eligible.length) throw new Error('Poker pot has no eligible player.');
    let winners = [eligible[0]!];
    for (const playerId of eligible.slice(1)) {
      const comparison =
        live.length === 1 ? 0 : comparePokerHands(showdown[playerId]!, showdown[winners[0]!]!);
      if (comparison > 0) winners = [playerId];
      else if (comparison === 0) winners.push(playerId);
    }
    pots.push({ amount, eligible, awards: awards(state, amount, winners) });
  }
  const endingStacks = stacks(state);
  const busted = hand.players.filter((playerId) => seat(state, playerId).stack === 0);
  const remaining = state.seats.filter((item) => item.stack > 0).length;
  const byStart = new Map<number, PlayerId[]>();
  for (const playerId of busted)
    byStart.set(hand.startingStacks[playerId]!, [
      ...(byStart.get(hand.startingStacks[playerId]!) ?? []),
      playerId,
    ]);
  const eliminations: PokerElimination[] = [];
  let higherBusted = 0;
  for (const [chipsAtHandStart, playerIds] of [...byStart].sort(([a], [b]) => b - a)) {
    const place = remaining + 1 + higherBusted;
    for (const playerId of playerIds.toSorted(
      (a, b) => seatIndex(state, a) - seatIndex(state, b),
    )) {
      const elimination = { playerId, hand: hand.number, place, chipsAtHandStart };
      state.eliminations.push(elimination);
      eliminations.push(elimination);
    }
    higherBusted += playerIds.length;
  }
  const revealedHoleCards =
    live.length > 1
      ? Object.fromEntries(live.map((playerId) => [playerId, [...hand.hole[playerId]!]]))
      : {};
  state.lastHand = {
    handNumber: hand.number,
    board: [...hand.board],
    actionHistory: clone(hand.actionHistory),
    pots: clone(pots),
    refunds: clone(refunds),
    endingStacks,
    eliminations: clone(eliminations),
    showdownRanks: clone(showdown),
    revealedHoleCards,
  };
  effects.push({
    kind: 'poker_hand_finished',
    hand: hand.number,
    level: level(state),
    deckSeed: `${state.seed}:hand:${hand.number}:deck`,
    buttonSeat: hand.buttonSeat,
    smallBlindSeat: hand.smallBlindSeat,
    bigBlindSeat: hand.bigBlindSeat,
    startingStacks: hand.startingStacks,
    endingStacks,
    liveContributions: hand.livePut,
    deadContributions: hand.deadPut,
    holeCards: hand.hole,
    board: hand.board,
    burns: hand.burns,
    refunds,
    pots,
    showdown,
    eliminations,
  });
  state.handsCompleted += 1;
  state.hand = null;
  if (remaining > 1) startHand(state, undefined, effects);
}

function advance(state: PokerState, effects: PokerEffect[], fromSeat: number): void {
  const hand = state.hand!;
  if (contenders(state).length === 1) return settle(state, effects);
  const canAct = contenders(state).filter((playerId) => seat(state, playerId).stack > 0);
  if (canAct.length === 1 && (hand.streetPut[canAct[0]!] ?? 0) >= hand.currentBet)
    return settle(state, effects);
  const next = nextActor(state, fromSeat);
  if (next) {
    hand.actor = next;
    return;
  }
  hand.actor = null;
  if (hand.street === 'river') return settle(state, effects);
  if (canAct.length <= 1) return settle(state, effects);
  dealStreet(hand);
  hand.minRaise = level(state)[1];
  const first = nextActor(state, hand.buttonSeat);
  if (first) hand.actor = first;
  else settle(state, effects);
}

export function applyPoker(
  current: PokerState,
  playerId: PlayerId,
  action: PokerAction,
): { readonly state: PokerState; readonly effects: readonly PokerEffect[] } {
  const state = clone(current);
  const hand = state.hand;
  if (!hand || hand.actor !== playerId) throw new Error('Poker action is out of turn.');
  const option = pokerActions(state, playerId).find((item) => item.id === action.id);
  if (!option) throw new Error(`Poker action ${action.id} is not legal.`);
  const beforeBet = hand.currentBet;
  const beforePut = hand.streetPut[playerId] ?? 0;
  let contributed = 0;
  let fullRaise = false;
  if (action.id === 'fold') hand.folded.push(playerId);
  else if (action.id === 'call') {
    if (option.id !== 'call') throw new Error('Poker call is not legal.');
    contributed = commit(state, playerId, option.amount);
  } else if (action.id === 'bet' || action.id === 'raise') {
    integer(action.to, 'Poker target', true);
    if (
      (option.id !== 'bet' && option.id !== 'raise') ||
      action.to < option.minTo ||
      action.to > option.maxTo
    )
      throw new Error('Poker target is outside the legal range.');
    contributed = commit(state, playerId, action.to - beforePut);
    hand.currentBet = action.to;
    hand.minRaise = action.to - beforeBet;
    fullRaise = true;
  } else if (action.id === 'all_in') {
    if (option.id !== 'all_in') throw new Error('Poker all-in is not legal.');
    contributed = commit(state, playerId, seat(state, playerId).stack);
    if (option.to > beforeBet) {
      hand.currentBet = option.to;
      fullRaise = option.fullRaise;
      if (fullRaise) hand.minRaise = option.to - beforeBet;
    }
  }
  hand.actedAtBet = { ...hand.actedAtBet, [playerId]: hand.currentBet };
  const publicAction: PokerPublicAction = {
    street: hand.street,
    actor: playerId,
    action: clone(action),
    contributed,
    stackAfter: seat(state, playerId).stack,
    potAfter: pot(state),
    fullRaise,
  };
  hand.actionHistory.push(publicAction);
  const effects: PokerEffect[] = [{ kind: 'poker_action', hand: hand.number, ...publicAction }];
  advance(state, effects, seatIndex(state, playerId));
  assertPoker(state);
  return { state, effects };
}

export function pokerResult(state: PokerState): PokerResult | null {
  if (state.hand) return null;
  const survivor = state.seats.find((item) => item.stack > 0);
  if (!survivor) throw new Error('Poker has no survivor.');
  const placements: Record<PlayerId, number> = Object.fromEntries([
    ...state.eliminations.map((item) => [item.playerId, item.place]),
    [survivor.playerId, 1],
  ]);
  return {
    winner: survivor.playerId,
    handsPlayed: state.handsCompleted,
    stacks: stacks(state),
    placements,
    totalChips: state.initialChipTotal,
    lastHand: clone(state.lastHand!),
  };
}

export function pokerView(state: PokerState, playerId: PlayerId): PokerView {
  seat(state, playerId);
  const hand = state.hand;
  const holeCards = hand && Object.hasOwn(hand.hole, playerId) ? hand.hole[playerId] : undefined;
  const publicSeat = (index: number | null | undefined) =>
    index === null || index === undefined ? null : index + 1;
  return {
    handNumber: hand?.number ?? state.handsCompleted,
    street: hand?.street ?? 'complete',
    actor: hand?.actor ?? null,
    level: levelView(state),
    buttonSeat: publicSeat(hand?.buttonSeat),
    smallBlindSeat: publicSeat(hand?.smallBlindSeat),
    bigBlindSeat: publicSeat(hand?.bigBlindSeat),
    board: hand ? [...hand.board] : [],
    pot: pot(state),
    currentBet: hand?.currentBet ?? 0,
    minRaise: hand?.minRaise ?? 0,
    actionHistory: hand ? clone(hand.actionHistory) : [],
    seats: state.seats.map((item, index) => {
      const elimination = state.eliminations.find(({ playerId }) => playerId === item.playerId);
      const inHand = hand?.players.includes(item.playerId) ?? false;
      return {
        seat: index + 1,
        playerId: item.playerId,
        stack: item.stack,
        streetContribution: inHand ? hand!.streetPut[item.playerId]! : 0,
        handContribution: inHand
          ? hand!.livePut[item.playerId]! + hand!.deadPut[item.playerId]!
          : 0,
        status: !hand
          ? item.stack > 0
            ? ('active' as const)
            : ('eliminated' as const)
          : !inHand
            ? ('eliminated' as const)
            : hand.folded.includes(item.playerId)
              ? ('folded' as const)
              : item.stack === 0
                ? ('all_in' as const)
                : ('active' as const),
        ...(elimination ? { elimination: clone(elimination) } : {}),
      };
    }),
    ownHoleCards: holeCards ? [...holeCards] : null,
    lastHand: clone(state.lastHand),
  };
}

export function assertPoker(state: PokerState): void {
  if (
    state.version !== 1 ||
    state.seats.length !== 8 ||
    new Set(state.seats.map((item) => item.playerId)).size !== 8
  )
    throw new Error('Poker seat state is corrupt.');
  for (const item of state.seats) integer(item.stack, `Stack for ${item.playerId}`);
  const conserved = state.seats.reduce((sum, item) => sum + item.stack, 0) + pot(state);
  if (conserved !== state.initialChipTotal) throw new Error('Poker chips are not conserved.');
  const hand = state.hand;
  if (hand) {
    if (hand.deck.length !== 52 || new Set(hand.deck).size !== 52)
      throw new Error('Poker deck is corrupt.');
    const used = [...Object.values(hand.hole).flat(), ...hand.board, ...hand.burns];
    if (
      used.length !== hand.deckIndex ||
      new Set(used).size !== used.length ||
      used.some((card) => !hand.deck.includes(card))
    )
      throw new Error('Poker dealt cards are corrupt.');
    if (hand.players.some((id) => hand.hole[id]?.length !== 2))
      throw new Error('Poker hole cards are corrupt.');
    for (const playerId of hand.players) {
      integer(hand.streetPut[playerId]!, `Street contribution for ${playerId}`);
      integer(hand.livePut[playerId]!, `Live contribution for ${playerId}`);
      integer(hand.deadPut[playerId]!, `Dead contribution for ${playerId}`);
      if (hand.streetPut[playerId]! > hand.livePut[playerId]!)
        throw new Error('Poker contribution state is corrupt.');
    }
    if (hand.actor && !playerNeedsAction(state, hand.actor))
      throw new Error('Poker actor is corrupt.');
  } else if (state.seats.filter((item) => item.stack > 0).length !== 1) {
    throw new Error('Completed poker state has no sole survivor.');
  }
}
