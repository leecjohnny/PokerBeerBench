import { useSuspenseQuery } from '@tanstack/react-query';
import { Dialog } from '@base-ui/react/dialog';
import type { CreationInput } from '../../src/schema.ts';
import type { TournamentResult } from '../../src/game/tournament.ts';

export function TraceTable({
  url,
  viewerKey,
  players,
  biographies,
  result,
}: {
  url: string;
  viewerKey: string;
  players: { player_id: string }[];
  biographies: CreationInput['players'];
  result?: TournamentResult | undefined;
}) {
  const { data: summary } = useSuspenseQuery<{
    duration_seconds: number;
    output_tokens: number;
    trajectories?: { player_id?: string; seat: string }[];
  } | null>({
    queryKey: ['traces', url],
    queryFn: async () => {
      const response = await fetch(`${url}?summary`).catch(() => null);
      return response?.ok ? response.json() : null;
    },
    refetchInterval: (query) => (query.state.data ? false : 30_000),
  });
  if (!summary) return null;
  const ranks = new Map(result?.pokerB.scores.map(({ playerId, place }) => [playerId, place]));
  return (
    <div className="relative overflow-x-auto">
      <p className="mb-4">
        Duration (Harbor): {(summary.duration_seconds / 3600).toFixed(1)} hours · Output tokens:{' '}
        {summary.output_tokens.toLocaleString('en-US')}
      </p>
      <table className="w-full min-w-3xl text-left text-sm [&_td]:px-3 [&_td]:py-4 [&_td]:whitespace-nowrap [&_td]:tabular-nums [&_th]:px-3 [&_th]:py-3">
        <caption className="pb-3 text-left font-semibold">Player traces</caption>
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Poker A chips</th>
            <th scope="col">Beer cost / team</th>
            <th scope="col">Poker B chips</th>
            <th scope="col">Trajectory</th>
          </tr>
        </thead>
        <tbody>
          {players
            .toSorted((a, b) => (ranks.get(a.player_id) ?? 9) - (ranks.get(b.player_id) ?? 9))
            .map(({ player_id }) => {
              const bio = biographies.find(({ id }) => id === player_id);
              const trace = summary.trajectories?.find((entry) => entry.player_id === player_id);
              return (
                <tr key={player_id} className="border-t border-neutral-200">
                  <th scope="row" className="min-w-56 max-w-72 break-words font-normal">
                    <Dialog.Root>
                      <Dialog.Trigger
                        className="min-h-11 text-left underline hover:text-neutral-600 focus-visible:outline-2"
                        title={[bio?.publicBiography, bio?.privateBiography]
                          .filter(Boolean)
                          .join('\n\n')}
                      >
                        #{ranks.get(player_id) ?? '—'} {player_id}
                      </Dialog.Trigger>
                      <Dialog.Portal>
                        <Dialog.Backdrop className="fixed inset-0 bg-black/40" />
                        <Dialog.Popup className="fixed left-1/2 top-1/2 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-6 shadow-lg">
                          <Dialog.Title className="text-xl font-semibold">{player_id}</Dialog.Title>
                          <dl className="mt-4 whitespace-pre-wrap">
                            <dt className="font-semibold">Biography</dt>
                            <dd>{bio?.publicBiography || 'Not provided'}</dd>
                            <dt className="mt-4 font-semibold">Private goal</dt>
                            <dd>{bio?.privateBiography || 'Not provided'}</dd>
                          </dl>
                          <Dialog.Close className="mt-4 min-h-11 rounded border px-4 focus-visible:outline-2">
                            Close
                          </Dialog.Close>
                        </Dialog.Popup>
                      </Dialog.Portal>
                    </Dialog.Root>
                  </th>
                  {(['pokerA', 'beer', 'pokerB'] as const).map((stage) => {
                    const poker = stage === 'beer' ? undefined : result?.[stage];
                    const score = poker?.scores.find(({ playerId }) => playerId === player_id);
                    return (
                      <td key={stage}>
                        {poker
                          ? `${poker.stacks[player_id]?.toLocaleString('en-US')} (${score?.score ?? '—'} pts${stage === 'pokerA' ? ` / #${score?.place ?? '—'}` : ''})`
                          : stage === 'beer' && result
                            ? `${result.beer.costByPlayer[player_id]?.toLocaleString('en-US')} (${result.beer.bonusPlayerIds.includes(player_id) ? 'Winner' : 'Runner-up'})`
                            : '—'}
                      </td>
                    );
                  })}
                  <td>
                    {trace ? (
                      <a
                        className="inline-flex min-h-11 items-center px-3 underline focus-visible:outline-2"
                        target="_blank"
                        rel="noopener noreferrer"
                        href={`?${new URLSearchParams({ key: viewerKey, trace: `${url}?${new URLSearchParams({ player: player_id, seat: trace.seat })}` })}`}
                      >
                        View<span className="sr-only"> {player_id} trace</span>
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
