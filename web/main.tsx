import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { StrictMode, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ZodError } from 'zod';
import { creationSchema, type CreationInput } from '../src/schema.ts';
import { Button, Input, Textarea } from './components/ui.tsx';
import { TraceTable } from './components/traces.tsx';
import { TraceFrame } from './components/trace-frame.tsx';
import type { TournamentResult } from '../src/game/tournament.ts';
import './styles.css';

type Creation = {
  simulation_id: string;
  players: { player_id: string; mcp_url: string }[];
  viewer: { key: string; url: string };
};
type Observer = {
  simulation_id: string;
  status: 'running' | 'completed';
  stage: string;
  version: number;
  config_hash: string;
  retry_after_ms?: number;
  biographies: CreationInput['players'];
  players: ({ player_id: string } & Record<string, unknown>)[];
  actions: unknown;
  milestones: unknown;
  messages: unknown;
  result?: TournamentResult;
  atif_url?: string;
};

const playerIndexes = Array.from({ length: 8 }, (_, index) => index);
const demandModes = [
  ['static', 'Static'],
  ['random_seeded', 'Seeded'],
  ['provided', 'Provided'],
] as const;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status})`, {
      cause: response.status,
    });
  return body as T;
}

function Layout() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <header className="mb-8 flex items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <span className="text-lg font-semibold">PokerBeerBench</span>
      </header>
      <Outlet />
    </main>
  );
}

const Field = ({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) => (
  <label className={`grid gap-1.5 text-sm font-medium ${className}`}>
    {label}
    {children}
  </label>
);

function demandFrom(form: FormData, mode: CreationInput['beerDemand']['mode']) {
  if (mode === 'static') return { mode, value: Number(form.get('demandValue')) };
  if (mode === 'random_seeded') return { mode, seed: String(form.get('demandSeed') || '') };
  try {
    return { mode, values: JSON.parse(String(form.get('demandValues'))) };
  } catch {
    throw new Error('Provided demand must be valid JSON.');
  }
}

function CreatePage() {
  const [mode, setMode] = useState<CreationInput['beerDemand']['mode']>('static');
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: (input: CreationInput) =>
      request<Creation>('/api/simulations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
  });
  useEffect(() => {
    if (!mutation.data) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [mutation.data]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const players = playerIndexes.map((index) => {
        const id = String(form.get(`id-${index}`) || '').trim();
        const publicBiography = String(form.get(`public-${index}`) || '').trim();
        const privateBiography = String(form.get(`private-${index}`) || '').trim();
        return { id, publicBiography, ...(privateBiography ? { privateBiography } : {}) };
      });
      mutation.mutate(creationSchema.parse({ players, beerDemand: demandFrom(form, mode) }));
    } catch (cause) {
      setError(
        cause instanceof ZodError
          ? cause.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; ')
          : cause instanceof Error
            ? cause.message
            : 'Invalid simulation configuration.',
      );
    }
  }

  if (mutation.data) return <Secrets creation={mutation.data} />;
  const failure = error || mutation.error?.message;
  return (
    <section aria-labelledby="create-heading">
      <h1 id="create-heading" className="text-2xl font-semibold tracking-tight">
        Create simulation
      </h1>
      <form className="mt-6 grid gap-8" onSubmit={submit}>
        <fieldset className="grid gap-4">
          <legend className="mb-3 font-semibold">Players</legend>
          {playerIndexes.map((index) => (
            <div
              key={index}
              className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-2"
            >
              <Field label={`Player ${index + 1} ID`}>
                <Input
                  name={`id-${index}`}
                  defaultValue={`player-${index + 1}`}
                  maxLength={200}
                  required
                />
              </Field>
              <Field label="Public biography">
                <Input name={`public-${index}`} maxLength={2000} required />
              </Field>
              <Field label="Private biography (optional)" className="sm:col-span-2">
                <Textarea name={`private-${index}`} maxLength={2000} rows={2} />
              </Field>
            </div>
          ))}
        </fieldset>
        <fieldset className="grid gap-4">
          <legend className="font-semibold">Beer demand</legend>
          <div
            className="grid grid-cols-3 rounded-md border border-neutral-300 bg-white p-1"
            aria-label="Demand mode"
          >
            {demandModes.map(([value, label]) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-center justify-center rounded px-2 text-center text-sm has-checked:bg-neutral-950 has-checked:text-white has-focus-visible:ring-2 has-focus-visible:ring-neutral-950 has-focus-visible:ring-offset-2"
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="demandMode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                {label}
              </label>
            ))}
          </div>
          {mode === 'static' && (
            <Field label="Quantity">
              <Input name="demandValue" type="number" min="0" step="1" defaultValue="4" required />
            </Field>
          )}
          {mode === 'random_seeded' && (
            <Field label="Demand seed">
              <Input name="demandSeed" maxLength={200} required />
            </Field>
          )}
          {mode === 'provided' && (
            <Field label="4×50 demand JSON">
              <Textarea name="demandValues" rows={10} spellCheck={false} required />
            </Field>
          )}
        </fieldset>
        {failure && <Alert>{failure}</Alert>}
        <Button
          type="submit"
          disabled={mutation.isPending}
          focusableWhenDisabled
          className="w-full"
        >
          {mutation.isPending ? 'Creating…' : 'Create'}
        </Button>
      </form>
    </section>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      {children}
    </p>
  );
}

function Copy({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [status, setStatus] = useState(label);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Copied');
    } catch {
      setStatus('Copy failed');
    }
    setTimeout(() => setStatus(label), 1500);
  }
  return (
    <Button secondary onClick={copy}>
      <span aria-live="polite">{status}</span>
    </Button>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-2 rounded-md border border-neutral-200 bg-white p-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <code className="block overflow-auto text-xs">{value}</code>
      </div>
      <Copy value={value} />
    </div>
  );
}

function Secrets({ creation }: { creation: Creation }) {
  const entries = [
    ...creation.players.map(({ player_id, mcp_url }) => ({
      label: `${player_id} MCP URL`,
      value: mcp_url,
    })),
    { label: 'Viewer key', value: creation.viewer.key },
    { label: 'Viewer URL', value: creation.viewer.url },
  ];
  const all = entries.map(({ label, value }) => `${label}: ${value}`).join('\n');
  return (
    <section className="grid gap-4" aria-labelledby="secrets-heading">
      <div>
        <h1 id="secrets-heading" className="text-2xl font-semibold">
          Simulation created
        </h1>
        <p className="mt-2 text-sm text-amber-800">
          These secrets are shown once. Copy them before leaving.
        </p>
      </div>
      {entries.map(({ label, value }) => (
        <Secret key={label} label={label} value={value} />
      ))}
      <Copy value={all} label="Copy all" />
    </section>
  );
}

const terminal = (state?: Observer) => state?.status === 'completed';

function ViewerPage() {
  const { simulationId } = useParams({ from: '/simulations/$simulationId' });
  const trace = new URLSearchParams(window.location.search).get('trace');
  const storageKey = `viewer:${simulationId}`;
  const [key, setKey] = useState(() => {
    const url = new URL(window.location.href);
    const supplied = url.searchParams.get('key');
    if (supplied) sessionStorage.setItem(storageKey, supplied);
    if (url.searchParams.has('key')) {
      url.searchParams.delete('key');
      window.history.replaceState(window.history.state, '', url);
    }
    return sessionStorage.getItem(storageKey) || '';
  });
  const query = useQuery({
    queryKey: ['simulation', simulationId, key],
    retry: (count, error) => count < 2 && Number(error.cause) >= 500,
    enabled: !!key && !trace,
    queryFn: () =>
      request<Observer>(`/api/simulations/${encodeURIComponent(simulationId)}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
    refetchInterval: ({ state }) =>
      terminal(state.data) || [401, 403, 404].includes(Number(state.error?.cause))
        ? false
        : Math.max(1000, state.data?.retry_after_ms ?? 3000),
  });
  if (trace) return <TraceFrame url={trace} back={`/simulations/${simulationId}`} />;
  if (!key || [401, 403, 404].includes(Number(query.error?.cause)))
    return (
      <section className="max-w-md" aria-labelledby="viewer-heading">
        <h1 id="viewer-heading" className="text-2xl font-semibold">
          View simulation
        </h1>
        <form
          className="mt-6 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const next = String(new FormData(event.currentTarget).get('key') || '').trim();
            sessionStorage.setItem(storageKey, next);
            setKey(next);
          }}
        >
          <Field label="Viewer key">
            <Input name="key" type="password" autoComplete="off" required />
          </Field>
          <Button type="submit">Open</Button>
        </form>
      </section>
    );
  const state = query.data;
  return (
    <section className="grid grid-cols-1 gap-6 [&>*]:min-w-0" aria-labelledby="viewer-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="viewer-heading" className="text-2xl font-semibold">
            Simulation
          </h1>
          <p className="mt-1 break-all text-sm text-neutral-600">{simulationId}</p>
        </div>
        <div className="flex gap-2">
          <Button secondary onClick={() => query.refetch()} disabled={query.isFetching}>
            Refresh
          </Button>
        </div>
      </div>
      {query.error && <Alert>{query.error.message}</Alert>}
      {query.isPending && <p role="status">Loading…</p>}
      {terminal(state) && state?.atif_url && (
        <Suspense fallback={<p role="status">Checking player traces…</p>}>
          <TraceTable
            url={state.atif_url}
            viewerKey={key}
            players={state.players}
            biographies={state.biographies}
            result={state.result}
          />
        </Suspense>
      )}
      {state && <ObserverView state={state} />}
    </section>
  );
}

function JsonSection({
  title,
  value,
  open = false,
}: {
  title: string;
  value: unknown;
  open?: boolean;
}) {
  if (value === undefined || value === null) return null;
  return (
    <details open={open} className="rounded-lg border border-neutral-200 bg-white px-4">
      <summary>{title}</summary>
      <pre className="border-t border-neutral-100 py-4">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function ObserverView({ state }: { state: Observer }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-4">
        {(
          [
            ['Status', state.status],
            ['Stage', state.stage],
            ['Version', state.version],
            ['Config', state.config_hash],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs font-medium text-neutral-500">{label}</dt>
            <dd className="mt-1 truncate text-sm font-medium" title={String(value)}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-1 gap-3 [&>*]:min-w-0">
        {state.players.map((player) => (
          <JsonSection key={player.player_id} title={player.player_id} value={player} />
        ))}
        <JsonSection title="Biographies" value={state.biographies} />
        <JsonSection title="Actions" value={state.actions} />
        <JsonSection title="Milestones" value={state.milestones} />
        <JsonSection title="Messages" value={state.messages} />
        <JsonSection title="Final result" value={state.result} open={terminal(state)} />
      </div>
    </>
  );
}

const rootRoute = createRootRoute({ component: Layout });
const createRouteNode = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: CreatePage,
});
const viewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/simulations/$simulationId',
  component: ViewerPage,
});
const router = createRouter({ routeTree: rootRoute.addChildren([createRouteNode, viewerRoute]) });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
