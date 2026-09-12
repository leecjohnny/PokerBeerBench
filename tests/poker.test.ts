import { describe, expect, it } from 'vitest';
import {
  applyPoker,
  assertPoker,
  comparePokerHands,
  createPoker,
  evaluateHoldem,
  pokerActions,
  pokerResult,
  pokerView,
  shuffledDeck,
  type BlindLevel,
  type Card,
  type PokerAction,
  type PokerEffect,
  type PokerState,
} from '../src/game/poker.ts';
const players = Array.from({ length: 8 }, (_, index) => `p${index + 1}`);
const prototypeIds = [
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];
const rules = (...levels: BlindLevel[]) => ({ blindSchedule: levels });
const equalStacks = (amount = 100) => Object.fromEntries(players.map((id) => [id, amount]));
const standardRules = rules([1, 2, 0, 20]);
const game = (seed: string, stacks = equalStacks(), gameRules = standardRules): PokerState =>
  createPoker(players, stacks, gameRules, seed);
function act(
  state: PokerState,
  action: PokerAction,
): { state: PokerState; effects: readonly PokerEffect[] } {
  if (!state.hand?.actor) throw new Error('Test expected a poker actor.');
  return applyPoker(state, state.hand.actor, action);
}
function passive(optionIds: readonly string[]): PokerAction {
  if (optionIds.includes('check')) return { id: 'check' };
  if (optionIds.includes('call')) return { id: 'call' };
  return { id: 'fold' };
}
const actionIds = (state: PokerState, playerId = state.hand!.actor!) =>
  pokerActions(state, playerId).map(({ id }) => id);
function finishStreet(state: PokerState): PokerState {
  const street = state.hand?.street;
  while (state.hand?.street === street) state = act(state, passive(actionIds(state))).state;
  return state;
}
function handEvidence(
  effects: readonly PokerEffect[],
): Extract<PokerEffect, { kind: 'poker_hand_finished' }> {
  const evidence = effects.find((effect) => effect.kind === 'poker_hand_finished');
  if (evidence?.kind !== 'poker_hand_finished') throw new Error('Missing hand evidence.');
  return evidence;
}
function actionEvidence(effects: readonly PokerEffect[], actor: string, actionId: string) {
  return effects.find(
    (effect) =>
      effect.kind === 'poker_action' && effect.actor === actor && effect.action.id === actionId,
  );
}
function finishHand(state: PokerState, choose = passive) {
  const hand = state.hand?.number;
  const effects: PokerEffect[] = [];
  while (state.hand?.number === hand) {
    const result = act(state, choose(actionIds(state)));
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
function blindPlayers(state: PokerState) {
  const hand = state.hand!;
  return [
    state.seats[hand.smallBlindSeat!]!.playerId,
    state.seats[hand.bigBlindSeat]!.playerId,
    state.seats[(hand.bigBlindSeat + 1) % state.seats.length]!.playerId,
  ] as const;
}
describe('poker hand evaluation', () => {
  const cases: readonly [PokerEffect extends never ? never : string, Card[], string][] = [
    ['straight flush', ['As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d'], 'straight_flush'],
    ['quads', ['Ac', 'Ad', 'Ah', 'As', 'Kc', '2d', '3h'], 'four_of_a_kind'],
    ['full house', ['Ac', 'Ad', 'Ah', 'Kc', 'Kd', '2d', '3h'], 'full_house'],
    ['flush', ['Ac', 'Jc', '8c', '4c', '2c', 'Kd', 'Qh'], 'flush'],
    ['straight', ['9c', '8d', '7h', '6s', '5c', 'Ad', 'Kh'], 'straight'],
    ['trips', ['Ac', 'Ad', 'Ah', 'Kc', 'Qd', '2d', '3h'], 'three_of_a_kind'],
    ['two pair', ['Ac', 'Ad', 'Kc', 'Kd', 'Qd', '2d', '3h'], 'two_pair'],
    ['pair', ['Ac', 'Ad', 'Kc', 'Qd', 'Jh', '2d', '3h'], 'pair'],
    ['high card', ['Ac', 'Kd', 'Qh', 'Js', '9c', '2d', '3h'], 'high_card'],
  ];
  it.each(cases)('recognizes %s', (_name, cards, category) => {
    expect(evaluateHoldem(cards).category).toBe(category);
  });
  it('handles a wheel and board-playing ties', () => {
    expect(evaluateHoldem(['Ac', '2d', '3h', '4s', '5c']).tie).toEqual([4, 5]);
    const board = ['As', 'Ks', 'Qs', 'Js', 'Ts'] as const;
    const left = evaluateHoldem(['2c', '3d', ...board]);
    const right = evaluateHoldem(['9c', '9d', ...board]);
    expect(comparePokerHands(left, right)).toBe(0);
  });
  it('rejects duplicate and undersized inputs', () => {
    expect(() => evaluateHoldem(['Ac', 'Ac', '3h', '4s', '5c'])).toThrow(/unique/);
    expect(() => evaluateHoldem(['Ac', '2d', '3h', '4s'])).toThrow(/five through seven/);
  });
});
describe('serializable tournament poker reducer', () => {
  it('shuffles all 52 unique cards reproducibly without the old 32-bit seed collision', () => {
    const seeds = ['audit-479599', 'audit-662382', '多言語-poker', 'a'.repeat(256)];
    const decks = seeds.map(shuffledDeck);
    for (const [index, deck] of decks.entries()) {
      expect(deck).toEqual(shuffledDeck(seeds[index]!));
      expect(deck).toHaveLength(52);
      expect(new Set(deck).size).toBe(52);
      expect(deck.toSorted()).toEqual(decks[0]!.toSorted());
    }
    expect(decks[0]).not.toEqual(decks[1]);
  });
  it.each(['bet', 'raise'] as const)('rejects nonnumeric %s targets without mutation', (id) => {
    const initial = game('invalid-target');
    const state = id === 'bet' ? finishStreet(initial) : initial;
    const before = structuredClone(state);
    const targets: unknown[] = ['6', [6], null, true, undefined];
    for (const to of targets) {
      expect(() => applyPoker(state, state.hand!.actor!, { id, to: to as number })).toThrow(
        /Poker target/,
      );
      expect(state).toEqual(before);
    }
  });
  it('retains betting opportunities and showdown evidence for prototype-like IDs', () => {
    let state = createPoker(
      prototypeIds,
      Object.fromEntries(prototypeIds.map((id) => [id, 100])),
      standardRules,
      'prototype-opportunities',
    );
    const actors: string[] = [];
    for (let count = 0; count < 8; count += 1) {
      expect(state.hand).toMatchObject({ number: 1, street: 'preflop' });
      actors.push(state.hand!.actor!);
      state = JSON.parse(JSON.stringify(act(state, passive(actionIds(state))).state)) as PokerState;
    }
    expect(actors.toSorted()).toEqual(prototypeIds.toSorted());
    expect(state.hand).toMatchObject({ number: 1, street: 'flop' });
    const completed = finishHand(state);
    expect(Object.keys(handEvidence(completed.effects).showdown).toSorted()).toEqual(
      prototypeIds.toSorted(),
    );
    expect(Object.keys(completed.state.lastHand!.revealedHoleCards).toSorted()).toEqual(
      prototypeIds.toSorted(),
    );
  });
  it.each([
    { name: 'ordinary', ids: players },
    { name: 'prototype-like', ids: prototypeIds },
  ])('shows zero contributions and no cards for eliminated $name IDs', ({ ids }) => {
    let state = createPoker(
      ids,
      Object.fromEntries(ids.map((id) => [id, 100])),
      standardRules,
      'eliminated-view',
    );
    state = act(state, { id: 'all_in' }).state;
    state = act(state, { id: 'call' }).state;
    state = finishHand(state, () => ({ id: 'fold' })).state;
    expect(state.hand?.number).toBe(2);
    const view = pokerView(state, ids[0]!);
    const eliminated = view.seats.filter(({ status }) => status === 'eliminated');
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0]).toMatchObject({ streetContribution: 0, handContribution: 0 });
    expect(pokerView(state, eliminated[0]!.playerId).ownHoleCards).toBeNull();
    expect(view.seats.every(({ handContribution }) => Number.isFinite(handContribution))).toBe(
      true,
    );
  });
  it('seats and deals deterministically, posts BB before BBA, and redacts private state', () => {
    const dealRules = rules([1, 2, 2, 2]);
    const first = game('deal', equalStacks(), dealRules);
    const replay = game('deal', equalStacks(), dealRules);
    const different = game('other', equalStacks(), dealRules);
    expect(first).toEqual(replay);
    expect(first.hand?.hole).not.toEqual(different.hand?.hole);
    expect(new Set(first.hand?.deck).size).toBe(52);
    expect(Object.values(first.hand!.hole).every((cards) => cards.length === 2)).toBe(true);
    expect(
      [...Object.values(first.hand!.livePut), ...Object.values(first.hand!.deadPut)].reduce(
        (sum, amount) => sum + amount,
        0,
      ),
    ).toBe(5);
    const bb = first.seats[first.hand!.bigBlindSeat]!.playerId;
    expect(first.hand!.streetPut[bb]).toBe(2);
    expect(first.hand!.livePut[bb]).toBe(2);
    expect(first.hand!.deadPut[bb]).toBe(2);
    const viewer = first.hand!.actor!;
    const view = pokerView(first, viewer);
    const serialized = JSON.stringify(view);
    expect(view.ownHoleCards).toEqual(first.hand!.hole[viewer]);
    expect(view).not.toHaveProperty('actions');
    expect(view.seats.map(({ seat }) => seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(view.buttonSeat).toBe(first.hand!.buttonSeat + 1);
    expect(view.smallBlindSeat).toBe(first.hand!.smallBlindSeat! + 1);
    expect(view.bigBlindSeat).toBe(first.hand!.bigBlindSeat + 1);
    expect(view.level).toEqual({
      number: 1,
      smallBlind: 1,
      bigBlind: 2,
      bigBlindAnte: 2,
      handsInLevel: 2,
      handsRemaining: 2,
    });
    expect(serialized).not.toContain(first.seed);
    for (const [id, cards] of Object.entries(first.hand!.hole))
      if (id !== viewer) for (const card of cards) expect(serialized).not.toContain(card);
    expect(view).not.toHaveProperty('deck');
  });
  it('deals every street with burns, charges only outstanding blinds, and advances levels', () => {
    let state = game('streets', equalStacks(), rules([1, 2, 0, 1], [2, 4, 0, 2]));
    const [smallBlind, bigBlind] = blindPlayers(state);
    const completed = finishHand(state);
    state = completed.state;
    const hand = handEvidence(completed.effects);
    expect(hand.board).toHaveLength(5);
    expect(hand.burns).toHaveLength(3);
    expect(actionEvidence(completed.effects, smallBlind, 'call')).toMatchObject({ contributed: 1 });
    expect(actionEvidence(completed.effects, bigBlind, 'check')).toMatchObject({ contributed: 0 });
    expect(state.handsCompleted).toBe(1);
    expect(state).not.toHaveProperty('levelIndex');
    expect(pokerView(state, players[0]!).level).toEqual({
      number: 2,
      smallBlind: 2,
      bigBlind: 4,
      bigBlindAnte: 0,
      handsInLevel: 2,
      handsRemaining: 2,
    });
  });
  it('shows public betting history and separates street from hand contributions', () => {
    let state = game('betting-surface');
    const opener = state.hand!.actor!;
    state = applyPoker(state, opener, { id: 'raise', to: 6 }).state;
    let view = pokerView(
      state,
      players.find((id) => id !== opener)!,
    );
    expect(view.currentBet).toBe(6);
    expect(view.minRaise).toBe(4);
    expect(view.seats.find(({ playerId }) => playerId === opener)).toMatchObject({
      streetContribution: 6,
      handContribution: 6,
    });
    expect(view.actionHistory).toEqual([
      {
        street: 'preflop',
        actor: opener,
        action: { id: 'raise', to: 6 },
        contributed: 6,
        stackAfter: 94,
        potAfter: 9,
        fullRaise: true,
      },
    ]);
    state = finishStreet(state);
    view = pokerView(state, opener);
    expect(view).toMatchObject({ street: 'flop', currentBet: 0, minRaise: 2 });
    expect(view.seats.every(({ streetContribution }) => streetContribution === 0)).toBe(true);
    expect(view.seats.some(({ handContribution }) => handContribution > 0)).toBe(true);
    expect(view.actionHistory.every(({ street }) => street === 'preflop')).toBe(true);
    state = act(state, { id: 'bet', to: 20 }).state;
    expect(pokerActions(state, state.hand!.actor!).find(({ id }) => id === 'raise')).toMatchObject({
      minTo: 40,
    });
  });
  it('does not reopen a single short raise but does reopen cumulative short raises', () => {
    const seed = 'cumulative';
    const [sb, bb, third] = blindPlayers(game(seed));
    const stackMap = equalStacks();
    stackMap[bb] = 5;
    stackMap[third] = 6;
    let state = finishStreet(game(seed, stackMap));
    expect(state.hand?.actor).toBe(sb);
    state = applyPoker(state, sb, { id: 'bet', to: 2 }).state;
    expect(pokerActions(state, bb)).toContainEqual({ id: 'all_in', to: 3, fullRaise: false });
    state = applyPoker(state, bb, { id: 'all_in' }).state;
    expect(state.hand!.actor).toBe(third);
    let single = applyPoker(state, third, { id: 'call' }).state;
    while (single.hand?.actor !== sb) single = act(single, { id: 'fold' }).state;
    expect(pokerActions(single, sb).some((item) => item.id === 'raise')).toBe(false);
    expect(pokerActions(state, third)).toContainEqual({ id: 'all_in', to: 4, fullRaise: false });
    state = applyPoker(state, third, { id: 'all_in' }).state;
    state = act(state, { id: 'call' }).state;
    while (state.hand?.actor !== sb) state = act(state, { id: 'fold' }).state;
    expect(pokerActions(state, sb).some((item) => item.id === 'raise')).toBe(true);
  });
  it('requires a full raise above a short all-in opening', () => {
    const seed = 'completion';
    const [sb, bb] = blindPlayers(game(seed));
    const stackMap = equalStacks();
    stackMap[sb] = 3;
    stackMap[bb] = 5;
    let state = finishStreet(game(seed, stackMap));
    expect(state.hand?.actor).toBe(sb);
    state = applyPoker(state, sb, { id: 'all_in' }).state;
    expect(pokerActions(state, bb)).toContainEqual({ id: 'raise', minTo: 3, maxTo: 3 });
    const result = applyPoker(state, bb, { id: 'raise', to: 3 });
    expect(result.effects[0]).toMatchObject({ kind: 'poker_action', fullRaise: true });
  });
  it('runs out dry side pots and returns uncalled excess', () => {
    const seed = 'dry-side-pots';
    const baseline = game(seed);
    const first = baseline.seats.findIndex(({ playerId }) => playerId === baseline.hand!.actor);
    const order = baseline.seats.map(
      (_, offset) => baseline.seats[(first + offset) % baseline.seats.length]!.playerId,
    );
    const stacks = [40, 32, 84, 78, 97, 10, 86, 5];
    let state = game(
      seed,
      Object.fromEntries(order.map((id, index) => [id, stacks[index]!])),
      rules([1, 2, 2, 1]),
    );
    const sequence: PokerAction[] = [
      { id: 'call' },
      { id: 'all_in' },
      { id: 'fold' },
      { id: 'raise', to: 67 },
      { id: 'call' },
      { id: 'call' },
      { id: 'fold' },
      { id: 'all_in' },
      { id: 'fold' },
    ];
    for (const action of sequence) state = act(state, action).state;
    expect(state.hand).toMatchObject({ street: 'flop', actor: order[3] });
    expect(
      act(state, { id: 'fold' }).effects.some(({ kind }) => kind === 'poker_hand_finished'),
    ).toBe(true);
    state = game('refund');
    const raiser = state.hand!.actor!;
    state = applyPoker(state, raiser, { id: 'raise', to: 10 }).state;
    const folded = finishHand(state, () => ({ id: 'fold' }));
    const evidence = handEvidence(folded.effects);
    expect(evidence.refunds).toEqual([{ playerId: raiser, amount: 8 }]);
    expect(evidence.pots.reduce((sum, item) => sum + item.amount, 0)).toBe(5);
  });
  it('never refunds or matches the big-blind ante as a live wager', () => {
    let state = game('ante-refund', equalStacks(), rules([1, 2, 2, 20]));
    const raiser = state.hand!.actor!;
    state = applyPoker(state, raiser, { id: 'raise', to: 10 }).state;
    const completed = finishHand(state, () => ({ id: 'fold' }));
    const evidence = handEvidence(completed.effects);
    expect(evidence.refunds).toEqual([{ playerId: raiser, amount: 8 }]);
    expect(evidence.pots.map(({ amount }) => amount)).toEqual([5, 2]);
  });
  it.each([
    [1, 1, 0, [8, 7]],
    [2, 2, 0, [16]],
    [3, 2, 1, [17]],
    [4, 2, 2, [18]],
  ] as const)(
    'settles a short big blind with stack %i without refunding its ante',
    (stack, live, dead, pots) => {
      const seed = 'bba-short-0';
      const gameRules = rules([1, 2, 2, 20]);
      const baseline = game(seed, equalStacks(), gameRules);
      const bigBlind = baseline.seats[baseline.hand!.bigBlindSeat]!.playerId;
      const stackMap = equalStacks();
      stackMap[bigBlind] = stack;
      const initial = game(seed, stackMap, gameRules);
      const hand = initial.hand!;
      const view = pokerView(initial, bigBlind);
      expect(hand).toMatchObject({ currentBet: 2 });
      expect(hand.streetPut[bigBlind]).toBe(live);
      expect(hand.livePut[bigBlind]).toBe(live);
      expect(hand.deadPut[bigBlind]).toBe(dead);
      expect(view.seats.find(({ playerId }) => playerId === bigBlind)?.handContribution).toBe(
        stack,
      );
      expect(view.pot).toBe(stack + 1);
      const completed = finishHand(initial);
      const evidence = handEvidence(completed.effects);
      expect(evidence.refunds).toEqual([]);
      expect(evidence.pots.map(({ amount }) => amount)).toEqual(pots);
      expect(evidence.liveContributions[bigBlind]).toBe(live);
      expect(evidence.deadContributions[bigBlind]).toBe(dead);
      expect(
        evidence.pots.flatMap(({ awards }) => awards).reduce((sum, item) => sum + item.amount, 0),
      ).toBe(pots.reduce((sum, amount) => sum + amount, 0));
      expect(evidence.eliminations).toContainEqual(expect.objectContaining({ playerId: bigBlind }));
      expect(completed.state.seats.find(({ playerId }) => playerId === bigBlind)?.stack).toBe(0);
      assertPoker(completed.state);
    },
  );
  it('builds canonical side pots and awards every committed chip', () => {
    const seed = 'side-pots';
    const baseline = game(seed);
    const first = baseline.seats.findIndex(({ playerId }) => playerId === baseline.hand!.actor);
    const order = baseline.seats.map(
      (_, offset) => baseline.seats[(first + offset) % baseline.seats.length]!.playerId,
    );
    const stackMap = Object.fromEntries(order.map((id, index) => [id, (index + 1) * 10]));
    const completed = finishHand(game(seed, stackMap), (ids) =>
      ids.includes('all_in') ? { id: 'all_in' } : { id: 'call' },
    );
    const { state } = completed;
    const evidence = handEvidence(completed.effects);
    expect(evidence.pots).toHaveLength(7);
    expect(evidence.pots.reduce((sum, item) => sum + item.amount, 0)).toBe(350);
    expect(
      evidence.pots.flatMap((item) => item.awards).reduce((sum, item) => sum + item.amount, 0),
    ).toBe(350);
    expect(
      state.seats.reduce((sum, item) => sum + item.stack, 0) +
        [
          ...Object.values(state.hand?.livePut ?? {}),
          ...Object.values(state.hand?.deadPut ?? {}),
        ].reduce((sum, amount) => sum + amount, 0),
    ).toBe(360);
    expect(state.lastHand?.eliminations).toEqual(evidence.eliminations);
  });
  it('keeps one public settlement summary and reveals only showdown participants', () => {
    let state = game('settlement-view');
    const firstHand = state.hand!;
    const folded = firstHand.actor!;
    const foldedCards = [...firstHand.hole[folded]!];
    state = applyPoker(state, folded, { id: 'fold' }).state;
    const completed = finishHand(state);
    const view = pokerView(completed.state, players[0]!);
    const last = view.lastHand!;
    expect(last.handNumber).toBe(1);
    expect(completed.state.hand?.number).toBe(2);
    expect(last.actionHistory[0]).toMatchObject({ actor: folded, action: { id: 'fold' } });
    expect(last.board).toHaveLength(5);
    expect(last.pots.length).toBeGreaterThan(0);
    expect(last.refunds).toBeInstanceOf(Array);
    expect(last.endingStacks).toEqual(handEvidence(completed.effects).endingStacks);
    expect(Object.keys(last.revealedHoleCards).toSorted()).toEqual(
      Object.keys(last.showdownRanks).toSorted(),
    );
    expect(Object.keys(last.revealedHoleCards)).toHaveLength(7);
    for (const [id, cards] of Object.entries(last.revealedHoleCards))
      expect(cards).toEqual(firstHand.hole[id]);
    expect(last.revealedHoleCards).not.toHaveProperty(folded);
    const serialized = JSON.stringify(last);
    for (const card of foldedCards) expect(serialized).not.toContain(card);
    expect(last).not.toHaveProperty('burns');
    expect(last).not.toHaveProperty('deck');
    expect(last).not.toHaveProperty('deckSeed');
  });
  it('reveals no cards when folds end the hand', () => {
    let state = game('uncontested-view');
    expect(pokerView(state, players[0]!).actionHistory).toEqual([]);
    state = act(state, { id: 'fold' }).state;
    expect(state.hand?.actionHistory).toHaveLength(1);
    const completed = finishHand(state, () => ({ id: 'fold' }));
    expect(completed.state.lastHand).toMatchObject({
      board: [],
      showdownRanks: {},
      revealedHoleCards: {},
    });
    expect(completed.state.lastHand?.actionHistory).toHaveLength(7);
  });
  it('splits a board-playing pot and gives the odd chip left of the button', () => {
    let state = game('odd-chip');
    const hand = state.hand!;
    const sb = state.seats[hand.smallBlindSeat!]!.playerId;
    const bb = state.seats[hand.bigBlindSeat]!.playerId;
    const foldedContributor = state.seats[(hand.bigBlindSeat + 1) % 8]!.playerId;
    const board: Card[] = ['As', 'Ks', 'Qs', 'Js', 'Ts'];
    const remaining = hand.deck.filter((card) => !board.includes(card));
    for (const [index, id] of hand.players.entries())
      hand.hole[id] = remaining.slice(index * 2, index * 2 + 2);
    hand.board = board;
    hand.burns = remaining.slice(16, 19);
    hand.deckIndex = 24;
    hand.street = 'river';
    hand.actor = sb;
    hand.folded = hand.players.filter((id) => id !== sb && id !== bb);
    hand.streetPut = Object.fromEntries(hand.players.map((id) => [id, 0]));
    hand.actedAtBet = {};
    hand.currentBet = 0;
    hand.livePut[bb] = 1;
    state.seats[hand.bigBlindSeat]!.stack += 1;
    hand.livePut[foldedContributor] = 1;
    state.seats.find((item) => item.playerId === foldedContributor)!.stack -= 1;
    state = applyPoker(state, sb, { id: 'check' }).state;
    const result = applyPoker(state, bb, { id: 'check' });
    const evidence = handEvidence(result.effects);
    expect(evidence.pots).toEqual([
      {
        amount: 3,
        eligible: [sb, bb],
        awards: [
          { playerId: sb, amount: 2 },
          { playerId: bb, amount: 1 },
        ],
      },
    ]);
  });
  it('uses a dead button and a dead small blind when the prior big blind busts', () => {
    const seed = 'dead-1';
    const gameRules = rules([1, 2, 2, 20]);
    const baseline = game(seed, equalStacks(), gameRules);
    const oldBigBlind = baseline.seats[baseline.hand!.bigBlindSeat]!.playerId;
    const stackMap = equalStacks();
    stackMap[oldBigBlind] = 1;
    const state = finishHand(game(seed, stackMap, gameRules)).state;
    const oldBigBlindSeat = state.seats.findIndex(({ playerId }) => playerId === oldBigBlind);
    expect(state.seats[oldBigBlindSeat]?.stack).toBe(0);
    expect(state.hand?.smallBlindSeat).toBeNull();
    expect((state.hand!.bigBlindSeat + 7) % 8).toBe(oldBigBlindSeat);
    expect(state.hand!.buttonSeat).toBe((state.hand!.bigBlindSeat + 6) % 8);
    const bigBlind = state.seats[state.hand!.bigBlindSeat]!.playerId,
      completed = finishHand(state, () => ({ id: 'fold' })),
      evidence = handEvidence(completed.effects);
    expect(evidence.refunds).toEqual([{ playerId: bigBlind, amount: 2 }]);
    expect(evidence.pots).toEqual([
      { amount: 2, eligible: [bigBlind], awards: [{ playerId: bigBlind, amount: 2 }] },
    ]);
  });
  it('uses heads-up button, blind, and action order', () => {
    const finalists = new Set(['p1', 'p2']);
    const stackMap = Object.fromEntries(players.map((id) => [id, finalists.has(id) ? 100 : 2]));
    let state = game('hu-19', stackMap, rules([1, 2, 0, 1], [2, 4, 0, 20]));
    while (state.hand?.number === 1) {
      const actor = state.hand.actor!;
      const ids = actionIds(state, actor);
      const action: PokerAction = finalists.has(actor)
        ? passive(ids)
        : ids.includes('all_in')
          ? { id: 'all_in' }
          : passive(ids);
      state = applyPoker(state, actor, action).state;
    }
    expect(state.hand?.players.toSorted()).toEqual([...finalists].toSorted());
    expect(state.hand?.smallBlindSeat).toBe(state.hand?.buttonSeat);
    const button = state.seats[state.hand!.buttonSeat]!.playerId;
    const bigBlind = state.seats[state.hand!.bigBlindSeat]!.playerId;
    expect(state.hand?.actor).toBe(button);
    state = applyPoker(state, button, { id: 'call' }).state;
    state = applyPoker(state, bigBlind, { id: 'check' }).state;
    expect(state.hand).toMatchObject({ street: 'flop', actor: bigBlind });
  });
  it('round-trips JSON after every action, conserves chips, and shares equal-stack elimination places', () => {
    let state = game('freezeout', equalStacks(30), rules([1, 2, 2, 1], [2, 4, 4, 1]));
    for (let count = 0; state.hand && count < 200; count += 1) {
      const actor = state.hand.actor!;
      const ids = actionIds(state, actor);
      const action: PokerAction = ids.includes('all_in') ? { id: 'all_in' } : passive(ids);
      state = applyPoker(JSON.parse(JSON.stringify(state)) as PokerState, actor, action).state;
      assertPoker(state);
    }
    const result = pokerResult(state);
    expect(result?.totalChips).toBe(240);
    expect(result?.handsPlayed).toBeGreaterThan(0);
    expect(result?.placements[result.winner]).toBe(1);
    expect(Object.keys(result!.placements)).toHaveLength(8);
    expect(result?.lastHand).toEqual(state.lastHand);
    expect(state.eliminations.filter((item) => item.place === 2).length).toBeGreaterThan(1);
    expect(
      pokerView(state, result!.winner).seats.find((item) => item.playerId === result!.winner)
        ?.status,
    ).toBe('active');
    const eliminated = state.eliminations[0]!;
    expect(
      pokerView(state, result!.winner).seats.find(
        ({ playerId }) => playerId === eliminated.playerId,
      )?.elimination,
    ).toEqual(eliminated);
  });
});
