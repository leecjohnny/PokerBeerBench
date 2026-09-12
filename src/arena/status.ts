import { beerRotationCost, beerView, type BeerState } from '../game/beer.js';
import { beerTotals } from '../game/tournament.js';
import type { BenchmarkConfig } from '../shared.js';

// Current decisions stay self-contained; append-only history is delivered separately.
export const compactInfo = (info: unknown) =>
  Object.fromEntries(
    Object.entries(info as object).filter(
      ([key]) =>
        ![
          'actionHistory',
          'lastHand',
          'tournamentRules',
          'beerOutcome',
          'pokerAResult',
          'rules',
          'pokerBReward',
          'previousRotationResult',
        ].includes(key),
    ),
  );

export type StatusEvent = { event_id: string; stage: string; kind: string; payload: any };
export function statusUpdates(
  rows: StatusEvent[],
  playerId: string,
  teams: BeerState['teams'],
  rules: BenchmarkConfig['beer'],
) {
  const teamId = Object.keys(teams).find((id) => teams[id]!.includes(playerId));
  return rows.flatMap((row) => {
    const effects =
      row.kind === 'milestone' ? [{ kind: 'milestone', data: row.payload }] : row.payload.effects;
    return effects.flatMap(({ kind, data }: { kind: string; data: any }) => {
      let visible: object | undefined;
      if (kind === 'poker') {
        const effect = data.effect;
        kind = effect.kind;
        if (kind === 'poker_action') visible = effect;
        if (kind === 'poker_hand_finished') {
          const {
            hand: handNumber,
            board,
            pots,
            refunds,
            endingStacks,
            eliminations,
            showdown: showdownRanks,
          } = effect;
          visible = {
            handNumber,
            board,
            pots,
            refunds,
            endingStacks,
            eliminations,
            showdownRanks,
            revealedHoleCards: Object.fromEntries(
              Object.keys(showdownRanks).map((id) => [id, effect.holeCards[id]]),
            ),
          };
        }
      } else if (kind === 'draft_started' || kind === 'draft_pick') visible = data;
      else if (kind === 'milestone')
        visible = {
          stage: data.stage,
          ...(data.teams ? { teams: data.teams } : {}),
          ...(data.pokerResult ? { pokerResult: data.pokerResult } : {}),
          ...(data.beerOutcome ? { beerOutcome: beerTotals(data.beerOutcome) } : {}),
        };
      else if (kind === 'beer_order' && data.playerId === playerId) visible = data;
      else if (kind === 'beer_rotation' && teamId)
        visible = {
          rotation: data.rotation,
          results: data.results
            .filter((r: { teamId: string }) => r.teamId === teamId)
            .map((r: Parameters<typeof beerRotationCost>[0]) => ({
              ...r,
              totalCost: beerRotationCost(r),
            })),
        };
      else if (kind === 'beer_week' && teamId) {
        const week = beerView(
          {
            captains: Object.keys(teams) as [string, string],
            teams,
            rotation: data.rotation,
            week: data.week,
            games: data.teams,
            pending: {},
            results: [],
          },
          playerId,
          rules,
        );
        visible = { ...compactInfo(week), submitted: true, submittedOrder: week.previousOrder };
      }
      return visible ? [{ cursor: row.event_id, stage: row.stage, kind, data: visible }] : [];
    });
  });
}
