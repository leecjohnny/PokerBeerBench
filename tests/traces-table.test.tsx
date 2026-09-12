import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TraceTable } from '../web/components/traces.tsx';
import type { TournamentResult } from '../src/game/tournament.ts';

const url = `/atif_view/${'a'.repeat(64)}/`;
const players = ['Satya Nadella', '吳泳銘', 'A & B', 'D', 'E', 'F', 'G', 'H'].map((player_id) => ({
  player_id,
}));
const trajectories = [
  { seat: '1' },
  { seat: '2' },
  ...players.toReversed().map(({ player_id }, index) => ({ player_id, seat: String(index + 3) })),
];
function render(
  exists?: boolean,
  result?: TournamentResult,
  mapping: { player_id?: string; seat: string }[] | null = trajectories,
) {
  const client = new QueryClient();
  if (exists !== undefined)
    client.setQueryData(
      ['traces', url],
      exists
        ? {
            duration_seconds: 7200,
            output_tokens: 123456,
            ...(mapping && { trajectories: mapping }),
          }
        : null,
    );
  return renderToString(
    <QueryClientProvider client={client}>
      <Suspense fallback="Checking traces">
        <TraceTable
          url={url}
          viewerKey="test-viewer-key"
          players={players}
          result={result}
          biographies={players.map(({ player_id }) => ({
            id: player_id,
            publicBiography: 'Public biography',
            privateBiography: 'Private goal',
          }))}
        />
      </Suspense>
    </QueryClientProvider>,
  );
}
it('renders player links using the published trajectory metadata, not Arena seat order', () => {
  const html = render(true);
  expect(html.match(/<a /g)).toHaveLength(8);
  expect(html).toContain('player%3DSatya%2BNadella%26seat%3D10');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('2.0');
  expect(html).toContain('123,456');
  expect(html).toContain('scope="col"');
});
it.each([null, [], [{ seat: '1' }]])(
  'does not guess player links without matching metadata: %j',
  (mapping) => {
    const html = render(true, undefined, mapping);
    expect(html).toContain('<table');
    expect(html).not.toContain('<a ');
  },
);
it('links only players with a matching published trajectory', () => {
  const html = render(true, undefined, [
    { player_id: 'unknown player', seat: '1' },
    { player_id: 'Satya Nadella', seat: '12' },
  ]);
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('player%3DSatya%2BNadella%26seat%3D12');
});
it('does not render a table or launch link for an absent archive', () => {
  expect(render(false)).not.toContain('<table');
  expect(render(false)).not.toContain('<a ');
});
it('suspends while checking archive availability', () => {
  expect(render()).toContain('Checking traces');
});
it('shows final chip and Beer results with biography dialog triggers', () => {
  const result = {
    pokerA: {
      stacks: { 'Satya Nadella': 0, 吳泳銘: 400000 },
      scores: [
        { playerId: 'Satya Nadella', score: 4, place: 5 },
        { playerId: '吳泳銘', score: 8, place: 1 },
      ],
    },
    pokerB: {
      stacks: { 'Satya Nadella': 540000, 吳泳銘: 0 },
      scores: [
        { playerId: 'Satya Nadella', score: 8, place: 1 },
        { playerId: '吳泳銘', score: 2, place: 7 },
      ],
    },
    beer: {
      costByPlayer: { 'Satya Nadella': 3959.5, 吳泳銘: 0 },
      bonusPlayerIds: ['Satya Nadella'],
    },
  } as unknown as TournamentResult;
  const html = render(true, result);
  expect(html).toContain('540,000 (8 pts)');
  expect(html).toContain('0 (4 pts / #5)');
  expect(html).toContain('400,000 (8 pts / #1)');
  expect(html).toContain('0 (2 pts)');
  expect(html).toContain('3,959.5 (Winner)');
  expect(html).toContain('0 (Runner-up)');
  expect(html).toContain('Winner');
  expect(html).toContain('Runner-up');
  expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(8);
  expect(html).toContain('Public biography');
  expect(html).toContain('Private goal');
  expect(html).not.toContain('30-minute');
});
it('orders stages chronologically and players by final rank without changing trajectory links', () => {
  const result = {
    pokerB: {
      stacks: {},
      scores: players.map(({ player_id }, index) => ({
        playerId: player_id,
        place: 8 - index,
        score: index + 1,
      })),
    },
    beer: { costByPlayer: {}, bonusPlayerIds: [] },
  } as unknown as TournamentResult;
  const html = render(true, result);
  const headers = [...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
  expect(headers).toEqual([
    'Player',
    'Poker A chips',
    'Beer cost / team',
    'Poker B chips',
    'Trajectory',
  ]);
  expect(html).not.toContain('↓');
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
    new URLSearchParams(match[1]!.replaceAll('&amp;', '&')).get('trace')!,
  );
  expect(links[0]).toContain('player=H&seat=3');
  expect(links.at(-1)).toContain('player=Satya+Nadella&seat=10');
  const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) =>
    match[1]!.replaceAll(/<[^>]*>/g, ''),
  );
  expect(buttons[0]).toBe('#1 H');
  expect(buttons.at(-1)).toBe('#8 Satya Nadella');
});
