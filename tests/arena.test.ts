import { randomBytes } from 'node:crypto';
import { neonConfig } from '@neondatabase/serverless';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArenaStore } from '../src/arena/db.ts';
import { createArenaHttp } from '../src/arena/mcp.ts';
import { createSimulationRequest, simulationViewerRequest } from '../src/arena/rest.ts';
import { compactInfo, statusUpdates } from '../src/arena/status.ts';
import { applyBeerOrder, beerView, createBeer } from '../src/game/beer.ts';
import { sha256, type BenchmarkConfig, type CreationInput } from '../src/shared.ts';
const operatorCap = randomBytes(32).toString('base64url');
const operatorUrl = `http://localhost/mcp/${operatorCap}`;
const operatorCreateUrl = `${operatorUrl}?create`;
const players = Array.from({ length: 8 }, (_, index) => `player-${index + 1}`);
const descriptors = players.map((id, index) => ({
  id,
  publicBiography: `Public biography ${index + 1}`,
  privateBiography: `Private biography ${index + 1}`,
}));
const config: BenchmarkConfig = {
  version: 2,
  id: 'arena-test',
  seed: 'arena-test-seed',
  players: descriptors,
  messaging: { characterLimit: 160 },
  poker: { startingStack: 1_000, finalWinnerStackMultiplier: 2, blindSchedule: [[1, 5, 10, 10]] },
  beer: {
    demandPack: { mode: 'static', id: '0'.repeat(64) },
    holdingCost: 0.5,
    backlogCost: 1,
    orderDelayWeeks: 1,
    shippingDelayWeeks: 2,
    factoryRequestDelayWeeks: 1,
    factoryProductionDelayWeeks: 2,
    initialInventory: 12,
    initialPipelineQuantity: 4,
    warmupWeeks: 4,
    demand: Array.from({ length: 4 }, () => Array(50).fill(4)),
  },
};
const creation: CreationInput = { players: descriptors, beerDemand: { mode: 'static', value: 4 } };
const newBeer = () =>
  createBeer(
    [players[0]!, players[4]!],
    { [players[0]!]: players.slice(0, 4), [players[4]!]: players.slice(4) },
    config.beer,
  );
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
const revision = '2026-07-28';
type App = ReturnType<typeof createArenaHttp>;
const meta = (version = revision) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'arena-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});
async function dispatch(app: App, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) headers.set('host', new URL(url).host);
  const response = await app.fetch(new Request(url, { ...init, headers }));
  expect(['mcp-session-id', 'last-event-id'].some((name) => response.headers.has(name))).toBe(
    false,
  );
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    body: text.startsWith('{') ? JSON.parse(text) : text,
  };
}
const post = (app: App, url: string, body: object, headers: Record<string, string> = {}) =>
  dispatch(app, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
async function wire(
  app: App,
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  version = revision,
) {
  const headers: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': method };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  const exchange = await post(
    app,
    url,
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta(version) } },
    headers,
  );
  expect(exchange.type).toMatch(/^application\/json/);
  return exchange;
}
const secret = (url: string) => new URL(url).pathname.split('/').at(-1)!;
const legacyHeaders = { accept: 'application/json, text/event-stream' };
const sse = (value: unknown) => JSON.parse(String(value).split('data: ')[1]!.trim()).result;
const rejects = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
describe('Player status history projection', () => {
  it('projects completed Beer weeks and rotations only for the player’s role and team', () => {
    let beer = newBeer();
    let effects: ReturnType<typeof applyBeerOrder>['effects'] = [];
    for (let week = 1; week <= 50; week++)
      for (const id of players) {
        const applied = applyBeerOrder(beer, id, 4, config.beer);
        beer = applied.state;
        effects = applied.effects;
      }
    const rows = [{ event_id: '400', stage: 'beer', kind: 'action', payload: { effects } }];
    const updates = statusUpdates(rows, players[0]!, beer.teams, config.beer);
    expect(updates.map(({ kind }) => kind)).toEqual(['beer_week', 'beer_rotation']);
    const week = effects.find(({ kind }) => kind === 'beer_week')!.data;
    const expected = compactInfo(
      beerView(
        { ...beer, rotation: 1, week: 50, games: week.teams as typeof beer.games, results: [] },
        players[0]!,
        config.beer,
      ),
    );
    expect(updates[0]!.data).toEqual({ ...expected, submitted: true, submittedOrder: 4 });
    const teamResults = (team: string) =>
      beer.results
        .filter(({ teamId }) => teamId === team)
        .map((result) => ({
          ...result,
          totalCost: Object.values(result.costByPlayer).reduce((sum, cost) => sum + cost, 0),
        }));
    expect(updates[1]!.data).toEqual({
      rotation: 1,
      results: teamResults(players[0]!),
    });
    for (const hidden of [
      '"demand"',
      '"incomingOrders"',
      '"incomingShipments"',
      '"factoryRequests"',
      '"games"',
    ])
      expect(JSON.stringify(updates)).not.toContain(hidden);
    const own = statusUpdates(rows, players[7]!, beer.teams, config.beer);
    expect(own[0]).toMatchObject({
      kind: 'beer_order',
      data: { playerId: players[7], quantity: 4 },
    });
    expect(own.at(-1)!.data).toEqual({
      rotation: 1,
      results: teamResults(players[4]!),
    });
    const milestone = statusUpdates(
      [
        {
          event_id: '401',
          stage: 'poker_b',
          kind: 'milestone',
          payload: {
            stage: 'poker_b',
            beerOutcome: { captains: beer.captains, teams: beer.teams, results: beer.results },
          },
        },
      ],
      players[0]!,
      beer.teams,
      config.beer,
    )[0]!;
    expect(milestone).toMatchObject({
      kind: 'milestone',
      data: {
        stage: 'poker_b',
        beerOutcome: { winningTeamIds: beer.captains, bonusPlayerIds: players },
      },
    });
    expect(milestone.data).not.toHaveProperty('beerOutcome.results');
  });
  it('preserves new draft decisions and public stage milestones while dropping static info', () => {
    const pokerResult = {
      winner: players[0],
      placements: Object.fromEntries(players.map((id, index) => [id, index + 1])),
    };
    const teams = newBeer().teams;
    const data = [
      { stage: 'draft', pokerResult },
      { stage: 'beer', teams },
      { stage: 'complete', pokerResult },
    ];
    const decisions = [
      {
        kind: 'draft_started',
        data: { captains: [players[0], players[4]], firstCaptain: players[0] },
      },
      { kind: 'draft_pick', data: { captainId: players[0], playerId: players[1] } },
    ];
    const rows = data.map((payload, index) => ({
      event_id: String(index + 1),
      stage: payload.stage,
      kind: 'milestone',
      payload,
    }));
    expect(statusUpdates(rows, players[0]!, teams, config.beer).map(({ data }) => data)).toEqual(
      data,
    );
    expect(
      statusUpdates(
        [{ event_id: '4', stage: 'draft', kind: 'action', payload: { effects: decisions } }],
        players[0]!,
        teams,
        config.beer,
      ).map(({ kind, data }) => ({ kind, data })),
    ).toEqual(decisions);
    expect(
      compactInfo({
        winner: players[0],
        pokerAResult: pokerResult,
        beerOutcome: {},
        previousRotationResult: {},
        rules: {},
        pokerBReward: {},
      }),
    ).toEqual({ winner: players[0] });
  });
});
describe('Arena MCP transport', () => {
  const identity = { simulationId: 's1', seat: 1, playerId: players[0]! };
  const fake = {
    resolveCapability: async (hash: string) => (hash === sha256('x'.repeat(43)) ? identity : null),
    playerRules: async () => ({
      stage_sequence: ['Poker A', 'Draft', 'Beer', 'Poker B', 'Complete'],
    }),
    playerStatus: async () => ({ state: 'waiting', retry_after_ms: 30_000 }),
    getSimulation: async () => Promise.reject(new Error('Query read timeout')),
  } as unknown as ArenaStore;
  const app = createArenaHttp(fake, new URL(operatorUrl));
  afterAll(() => app.close());
  it('serves 2026-07-28 discover, catalogs, and envelopes without sessions', async () => {
    const playerUrl = 'http://localhost/mcp/' + 'x'.repeat(43);
    const catalogs = [
      [
        operatorCreateUrl,
        ['create_simulation', 'export_simulation', 'get_simulation', 'get_simulation_state'],
      ],
      [
        playerUrl,
        ['get_actions', 'get_rules', 'get_status', 'read_inbox', 'send_message', 'submit_action'],
      ],
    ] as const;
    for (const [url, names] of catalogs) {
      expect((await wire(app, url, 'server/discover')).body.result.supportedVersions).toEqual([
        revision,
      ]);
      const tools = (await wire(app, url, 'tools/list')).body.result.tools;
      expect(tools.map((tool: any) => tool.name).sort()).toEqual([...names].sort());
      if (url === playerUrl)
        expect(tools.find((tool: any) => tool.name === 'send_message').description).toContain(
          'do not switch to "all" merely to bypass the error',
        );
    }
    const status = await wire(app, playerUrl, 'tools/call', {
      name: 'get_status',
      arguments: { after_cursor: null },
    });
    expect(JSON.parse(status.body.result.content[0].text)).toEqual(
      status.body.result.structuredContent,
    );
    expect(status.body.result.structuredContent).toMatchObject({
      ok: true,
      state: 'waiting',
      retry_after_ms: 30_000,
    });
    const statusTool = (await wire(app, playerUrl, 'tools/list')).body.result.tools.find(
      (tool: any) => tool.name === 'get_status',
    );
    expect(statusTool.inputSchema.required).toContain('after_cursor');
    for (const args of [{}, { after_cursor: 42 }]) {
      const invalid = (
        await wire(app, playerUrl, 'tools/call', { name: 'get_status', arguments: args })
      ).body;
      expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    }
    const rules = await wire(app, playerUrl, 'tools/call', { name: 'get_rules', arguments: {} });
    expect(rules.body.result.structuredContent.stage_sequence).toEqual([
      'Poker A',
      'Draft',
      'Beer',
      'Poker B',
      'Complete',
    ]);
    const busy = await wire(app, operatorCreateUrl, 'tools/call', {
      name: 'get_simulation',
      arguments: { simulation_id: 's1' },
    });
    expect(busy.body.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
      retry_after_ms: 500,
    });
  });
  it('serves stateless compatibility and fails closed on bad traffic', async () => {
    expect(() => createArenaHttp(fake, new URL(operatorUrl + '?leak=1'))).toThrow(
      /query or fragment/,
    );
    expect(() => createArenaHttp(fake, new URL(operatorUrl + '#leak'))).toThrow(
      /query or fragment/,
    );
    const playerUrl = 'http://localhost/mcp/' + 'x'.repeat(43);
    const invalid = await dispatch(app, 'http://localhost/mcp/' + 'z'.repeat(43));
    const hostile = await dispatch(app, operatorCreateUrl, {
      headers: { host: 'attacker.example' },
    });
    const rejectedUrls = await Promise.all(
      [operatorUrl, operatorUrl + '?create=', operatorUrl + '?leak=1', playerUrl + '?create'].map(
        (url) => dispatch(app, url),
      ),
    );
    const legacy = await post(
      app,
      operatorCreateUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'client', version: '1' },
        },
      },
      legacyHeaders,
    );
    const playerLegacy = await post(
      app,
      playerUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'client', version: '1' },
        },
      },
      legacyHeaders,
    );
    const legacyTools = await post(
      app,
      operatorCreateUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      legacyHeaders,
    );
    const unsupported = await wire(app, operatorCreateUrl, 'server/discover', {}, '2099-01-01');
    const methods = await Promise.all(
      ['GET', 'DELETE'].map((method) => dispatch(app, operatorCreateUrl, { method })),
    );
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } };
    const noMethod = await post(app, operatorCreateUrl, body, { 'mcp-protocol-version': revision });
    const noEnvelope = await post(
      app,
      operatorCreateUrl,
      { ...body, params: {} },
      { 'mcp-protocol-version': revision, 'mcp-method': 'tools/list' },
    );
    expect([invalid.status, hostile.status]).toEqual([404, 403]);
    expect(rejectedUrls.map(({ status }) => status)).toEqual([404, 404, 404, 404]);
    expect(sse(legacy.body).protocolVersion).toBe('2025-11-25');
    expect(sse(playerLegacy.body).instructions).toContain(
      'Begin by calling `get_rules` once, then call `get_status`.',
    );
    expect(sse(legacyTools.body).tools).toHaveLength(4);
    expect(unsupported.body.error.code).toBe(-32022);
    expect([noMethod.body.error.code, noEnvelope.body.error.code]).toEqual([-32020, -32602]);
    expect(methods.map(({ status }) => status)).toEqual([405, 405]);
  });
});
describeDb('Postgres Arena', () => {
  const schema = `arena_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const store = new ArenaStore(databaseUrl ?? 'postgres://test@localhost/db', config);
  const fetch = vi
    .spyOn(neonConfig, 'fetchFunction', 'get')
    .mockReturnValue(async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        for (const { query, params } of body.queries ?? [body])
          results.push(
            await client.query({
              text: query,
              values: params,
              rowMode: 'array',
              types: { getTypeParser: () => (value: string) => value },
            }),
          );
        await client.query('COMMIT');
        return Response.json(body.queries ? { results } : results[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        return Response.json(
          { ...(error as object), message: (error as Error).message },
          { status: 400 },
        );
      } finally {
        client.release();
      }
    });
  const app = createArenaHttp(store, new URL(operatorUrl));
  let created: Awaited<ReturnType<ArenaStore['createSimulation']>>;
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await store.migrate();
    created = await store.createSimulation(creation, new URL(operatorUrl));
  }, 20_000);
  afterAll(async () => {
    await app.close();
    fetch.mockRestore();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  const identity = (index: number) =>
    store.resolveCapability(sha256(secret(created.players[index]!.mcp_url)));
  const createGame = async (runPlayers = descriptors) => {
    const run = await store.createSimulation(
      { ...creation, players: runPlayers },
      new URL(operatorUrl),
    );
    const seats = (
      await Promise.all(
        run.players.map(({ mcp_url }) => store.resolveCapability(sha256(secret(mcp_url)))),
      )
    ).map((seat) => seat!);
    return { run, seats };
  };
  const submit = async (
    ...args: Parameters<ArenaStore['submitAction']>
  ): Promise<Awaited<ReturnType<ArenaStore['submitAction']>>> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await store.submitAction(...args);
      } catch (error) {
        if (attempt >= 8 || (error as { code: string }).code !== 'BUSY') throw error;
      }
    }
  };
  const interleave = (match: string, operation: () => Promise<unknown>, before = false) => {
    const original = store.query.bind(store);
    const query = vi.spyOn(store, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      if (!sql.includes(match)) return original(sql, values);
      query.mockRestore();
      if (before) await operation();
      const result = await original(sql, values);
      if (!before) await operation();
      return result;
    }) as typeof store.query);
    return query;
  };
  const setBeer = async (run: typeof created, beer = newBeer()) => {
    const stored = (
      await pool.query('SELECT config_hash FROM simulations WHERE id=$1', [run.simulation_id])
    ).rows[0]!;
    const snapshot = { version: 1, stage: 'beer', beer };
    await pool.query('UPDATE simulations SET snapshot=$2,state_hash=$3 WHERE id=$1', [
      run.simulation_id,
      JSON.stringify(snapshot),
      sha256({ configHash: stored.config_hash, version: 0, snapshot }),
    ]);
  };
  const createBeerSimulation = async (beer = newBeer(), runPlayers = descriptors) => {
    const { run, seats } = await createGame(runPlayers);
    await setBeer(run, beer);
    return { run, seats };
  };
  it('uses exactly three tables and stores only capability hashes', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await store.query('SELECT 1');
    await store.query('SELECT 1');
    expect(timeout.mock.calls).toEqual([[2_500], [2_500]]);
    expect(new Set(timeout.mock.results.map(({ value }) => value)).size).toBe(2);
    timeout.mockRestore();
    await rejects(store.query('SELECT pg_sleep(3)'), 'BUSY');
    const tables = (
      await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename`, [
        schema,
      ])
    ).rows.map((row) => row.tablename);
    expect(tables).toEqual(['arena_events', 'seats', 'simulations']);
    const columns = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='simulations'`,
        [schema],
      )
    ).rows.map((row) => row.column_name);
    expect(columns).toContain('snapshot');
    expect(columns).toContain('config');
    expect(columns).not.toContain('stage');
    expect(columns).not.toContain('status');
    await store.migrate();
    await expect(store.getSimulation(created.simulation_id)).resolves.toMatchObject({
      stage: 'poker_a',
    });
    expect(created.players).toHaveLength(8);
    expect(new Set(created.players.map(({ mcp_url }) => mcp_url)).size).toBe(8);
    expect(created.players.map(({ mcp_url }) => secret(mcp_url))).not.toContain(created.viewer.key);
    const stored = JSON.stringify({
      simulations: (await pool.query(`SELECT * FROM simulations`)).rows,
      seats: (await pool.query(`SELECT * FROM seats`)).rows,
    });
    for (const seat of created.players) {
      expect(stored).not.toContain(secret(seat.mcp_url));
      expect(stored).toContain(sha256(secret(seat.mcp_url)));
    }
    expect(stored).not.toContain(created.viewer.key);
    expect(stored).toContain(sha256(created.viewer.key));
    expect(created.viewer.url).not.toContain(created.viewer.key);
    expect(await identity(0)).toMatchObject({
      simulationId: created.simulation_id,
      seat: 1,
      playerId: players[0],
    });
  });
  it('isolates player biographies while authorizing the complete trusted observer', async () => {
    const own = await store.playerStatus((await identity(0))!);
    expect(own.players!.map(({ publicBiography }) => publicBiography)).toEqual(
      descriptors.map(({ publicBiography }) => publicBiography),
    );
    expect(own.players!.filter((player) => 'privateBiography' in player)).toEqual([descriptors[0]]);
    const rules = await store.playerRules((await identity(0))!);
    expect(rules).toMatchObject({
      stage_sequence: ['Poker A', 'Draft', 'Beer', 'Poker B', 'Complete'],
      poker_a: {
        scoring: '9 - final place.',
        actions: ['fold', 'check', 'call', 'bet', 'raise', 'all-in'],
        blind_schedule: { levels: 1 },
      },
      draft: { actions: ['draft.first_pick', 'draft.choose_captain', 'draft.pick'] },
      beer: {
        rotations: 4,
        weeks_per_rotation: 50,
        roles: ['retailer', 'wholesaler', 'distributor', 'factory'],
        costs: { holding: 0.5, backlog: 1 },
        action: { name: 'beer.order' },
      },
      poker_b: {
        scoring: expect.stringContaining('highest Poker B score'),
        actions: ['fold', 'check', 'call', 'bet', 'raise', 'all-in'],
      },
      complete: { scoring: expect.stringContaining('Poker B') },
      messaging: {
        tools: ['read_inbox', 'send_message'],
        availability: 'Read inbox anytime. Send only during Poker A, Draft, and Poker B.',
        direct: expect.stringContaining('player ID'),
        broadcast: expect.stringContaining('"all"'),
      },
      milestones: [
        { from: 'Poker A', to: 'Draft' },
        { from: 'Draft', to: 'Beer' },
        { from: 'Beer', to: 'Poker B' },
        { from: 'Poker B', to: 'Complete' },
      ],
    });
    const rulesText = JSON.stringify(rules);
    expect(rulesText).not.toContain(config.seed);
    expect(rulesText).not.toContain('Private biography');
    expect(rulesText).not.toContain('"demand"');
    expect(rulesText).not.toContain('"cards"');
    const overMcp = await wire(app, created.players[0]!.mcp_url, 'tools/call', {
      name: 'get_status',
      arguments: { after_cursor: null },
    });
    expect(
      overMcp.body.result.structuredContent.players.filter(
        (player: object) => 'privateBiography' in player,
      ),
    ).toEqual([descriptors[0]]);
    const rulesMcp = await wire(app, created.players[0]!.mcp_url, 'tools/call', {
      name: 'get_rules',
      arguments: {},
    });
    expect(rulesMcp.body.result.structuredContent).toMatchObject({
      ok: true,
      stage_sequence: rules.stage_sequence,
    });
    const viewer = await store.getViewerState(created.simulation_id, created.viewer.key);
    expect(viewer.biographies).toEqual(descriptors);
    for (const projection of viewer.players)
      expect(projection.players.filter((player) => 'privateBiography' in player)).toEqual([
        descriptors.find(({ id }) => id === projection.player_id),
      ]);
    const serialized = JSON.stringify(viewer);
    expect(serialized).not.toContain(operatorCap);
    for (const seat of created.players) expect(serialized).not.toContain(secret(seat.mcp_url));
    expect(serialized).not.toContain(created.viewer.key);
    const other = await store.createSimulation(creation, new URL(operatorUrl));
    await rejects(store.getViewerState(created.simulation_id, 'x'.repeat(43)), 'NOT_FOUND');
    await rejects(store.getViewerState(created.simulation_id, other.viewer.key), 'NOT_FOUND');
    await rejects(store.getViewerState('missing', created.viewer.key), 'NOT_FOUND');
  });
  it('uses the same store service for REST creation and query-time viewer projections', async () => {
    const request = new Request('http://localhost/api/simulations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creation),
    });
    const response = await createSimulationRequest(request, store, new URL(operatorUrl));
    expect(response.status).toBe(201);
    const run = (await response.json()) as typeof created;
    expect(run.players).toHaveLength(8);
    expect(run.viewer.url).not.toContain(run.viewer.key);
    const identities = await Promise.all(
      run.players.map(({ mcp_url }) => store.resolveCapability(sha256(secret(mcp_url)))),
    );
    const statuses = await Promise.all(identities.map((seat) => store.playerStatus(seat!)));
    const actor = statuses.find(({ state }) => state === 'action_required')!;
    const seat = identities.find((value) => value?.playerId === actor.player_id)!;
    const action = (await store.playerActions(seat)).actions[0]!;
    const before = await store.getViewerState(run.simulation_id, run.viewer.key);
    await store.submitAction(seat, actor.turn_id!, action.action_id);
    const authorized = await simulationViewerRequest(
      new Request(run.viewer.url, { headers: { authorization: `Bearer ${run.viewer.key}` } }),
      store,
      run.simulation_id,
    );
    expect(authorized.status).toBe(200);
    const after = (await authorized.json()) as typeof before;
    expect(after.version).toBe(before.version + 1);
    expect(after.actions).toHaveLength(before.actions.length + 1);
    expect(after.biographies).toEqual(descriptors);
    expect(after.actions.at(-1)).toMatchObject({
      player_id: actor.player_id,
      action: { action_id: action.action_id, parameters: {} },
    });
    const denied = await Promise.all([
      simulationViewerRequest(new Request(run.viewer.url), store, run.simulation_id),
      simulationViewerRequest(
        new Request(run.viewer.url, { headers: { authorization: `Bearer ${'z'.repeat(43)}` } }),
        store,
        run.simulation_id,
      ),
    ]);
    expect(denied.map(({ status }) => status)).toEqual([404, 404]);
    expect(await Promise.all(denied.map((item) => item.json()))).toEqual([
      { error: 'Simulation viewer not found.' },
      { error: 'Simulation viewer not found.' },
    ]);
  });
  it('atomically accepts and idempotently replays one legal action', async () => {
    const identities = await Promise.all(players.map((_, index) => identity(index)));
    const statuses = await Promise.all(identities.map((seat) => store.playerStatus(seat!)));
    expect(statuses.every(({ can_send_message }) => can_send_message)).toBe(true);
    expect(statuses.find((status) => status.state === 'waiting')).toMatchObject({
      retry_after_ms: 30_000,
    });
    const actor = statuses.find((status) => status.state === 'action_required')!;
    const seat = identities.find((item) => item?.playerId === actor.player_id)!;
    const actions = (await store.playerActions(seat)).actions;
    const action = actions[0]!;
    const before = await store.exportSimulation(created.simulation_id);
    await rejects(
      store.submitAction({ ...seat, seat: 9 }, actor.turn_id!, action.action_id),
      '23503',
    );
    expect(await store.exportSimulation(created.simulation_id)).toEqual(before);
    const submissions = await Promise.all([
      submit(seat, actor.turn_id!, action.action_id),
      submit(seat, actor.turn_id!, action.action_id),
    ]);
    expect(
      submissions
        .map(({ replayed, action }) => ({ replayed, action }))
        .sort((a, b) => Number(a.replayed) - Number(b.replayed)),
    ).toEqual([
      { replayed: false, action: { action_id: action.action_id, parameters: {} } },
      { replayed: true, action: { action_id: action.action_id, parameters: {} } },
    ]);
    const wrongSeat = identities.find((item) => item?.playerId !== actor.player_id)!;
    await rejects(store.submitAction(wrongSeat, actor.turn_id!, action.action_id), 'CONFLICT');
    const other = actions.find((item) => item.action_id !== action.action_id);
    if (other) await rejects(store.submitAction(seat, actor.turn_id!, other.action_id), 'CONFLICT');
    const count = await pool.query(
      `SELECT count(*) count FROM arena_events WHERE simulation_id=$1 AND turn_id=$2`,
      [created.simulation_id, actor.turn_id],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });
  it('returns a full refresh or replayable compact status with fresh unread guidance', async () => {
    const { run, seats } = await createGame();
    const statuses = await Promise.all(seats.map((seat) => store.playerStatus(seat)));
    const index = statuses.findIndex(({ state }) => state === 'action_required');
    const seat = seats[index]!;
    const initial = statuses[index]!;
    expect(initial).toMatchObject({ players: expect.any(Array), updates: [], has_more: false });
    expect(initial.next_cursor).toBe(`${run.simulation_id}/${seat.seat}/0`);
    const before = await store.exportSimulation(run.simulation_id);
    const compact = await store.playerStatus(seat, initial.next_cursor);
    expect(compact).toMatchObject({
      state: 'action_required',
      turn_id: initial.turn_id,
      unread_messages: 0,
      updates: [],
      next_cursor: initial.next_cursor,
      has_more: false,
    });
    expect(compact).not.toHaveProperty('players');
    for (const field of ['actionHistory', 'lastHand', 'tournamentRules'])
      expect(compact.info).not.toHaveProperty(field);
    expect(compact.info).toMatchObject({
      ownHoleCards: expect.any(Array),
      board: [],
      pot: expect.any(Number),
      currentBet: expect.any(Number),
      seats: expect.any(Array),
      actor: seat.playerId,
    });
    expect(await store.playerStatus(seat, initial.next_cursor)).toEqual(compact);
    expect(await store.exportSimulation(run.simulation_id)).toEqual(before);
    const other = await createGame();
    for (const cursor of [
      '',
      '0',
      `${run.simulation_id}/${seat.seat}/9007199254740993`,
      `${run.simulation_id}/${seat.seat}/1`,
      `${run.simulation_id}/${seats[(index + 1) % 8]!.seat}/0`,
      `${other.run.simulation_id}/${seat.seat}/0`,
    ])
      await rejects(store.playerStatus(seat, cursor), 'BAD_CURSOR');
    await store.sendMessage(
      seats[(index + 1) % 8]!,
      seat.playerId,
      'Unread without a game action.',
    );
    expect(await store.playerStatus(seat, initial.next_cursor)).toMatchObject({
      state: initial.state,
      turn_id: initial.turn_id,
      unread_messages: 1,
      message_guidance:
        'You have 1 unread messages. Call `read_inbox` before choosing your action.',
      updates: [],
    });
    await store.readInbox(seat);
    expect(await store.playerStatus(seat, initial.next_cursor)).toMatchObject({
      unread_messages: 0,
      message_guidance: 'You have no unread messages.',
      updates: [],
    });
    expect(await store.playerStatus(seat, null)).toMatchObject({
      players: initial.players,
      info: initial.info,
    });
  });
  it('pages new public poker history across multiple hands without consuming or leaking it', async () => {
    const { run, seats } = await createGame();
    const seat = seats[0]!;
    const initial = await store.playerStatus(seat, null);
    const committed: string[] = [];
    for (let index = 0; index < 56; index++) {
      const status = await store.playerStatus(seat);
      const actor = seats.find(
        ({ playerId }) => playerId === (status.info as { actor: string }).actor,
      )!;
      const actions = await store.playerActions(actor);
      expect(actions.actions.some(({ action_id }) => action_id === 'poker.fold')).toBe(true);
      committed.push((await store.submitAction(actor, actions.turn_id!, 'poker.fold')).event_id);
    }
    const before = await store.exportSimulation(run.simulation_id);
    const first = await store.playerStatus(seat, initial.next_cursor);
    expect(first.has_more).toBe(true);
    expect(
      first.updates.filter(({ kind }) => kind === 'poker_action').map(({ cursor }) => cursor),
    ).toEqual(committed.slice(0, 50).map((id) => `${run.simulation_id}/${seat.seat}/${id}`));
    expect(first.next_cursor).toBe(`${run.simulation_id}/${seat.seat}/${committed[49]}`);
    const last = await store.playerStatus(seat, first.next_cursor);
    expect(last.has_more).toBe(false);
    expect(
      last.updates.filter(({ kind }) => kind === 'poker_action').map(({ cursor }) => cursor),
    ).toEqual(committed.slice(50).map((id) => `${run.simulation_id}/${seat.seat}/${id}`));
    const finished = [...first.updates, ...last.updates].filter(
      ({ kind }) => kind === 'poker_hand_finished',
    );
    expect(finished).toHaveLength(8);
    expect(finished.map(({ data }) => (data as { handNumber: number }).handNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    for (const { data } of finished)
      expect(data).toMatchObject({
        revealedHoleCards: {},
        showdownRanks: {},
        pots: expect.any(Array),
        endingStacks: expect.any(Object),
      });
    const text = JSON.stringify([first, last]);
    for (const hidden of [
      '"deck"',
      '"deckSeed"',
      '"burns"',
      '"holeCards"',
      '"demand"',
      'biography',
      config.seed,
      secret(run.players[0]!.mcp_url),
    ])
      expect(text).not.toContain(hidden);
    expect(await store.playerStatus(seat, initial.next_cursor)).toEqual(first);
    expect(await store.playerStatus(seat, last.next_cursor)).toMatchObject({
      updates: [],
      next_cursor: last.next_cursor,
      has_more: false,
      info: last.info,
    });
    expect(await store.exportSimulation(run.simulation_id)).toEqual(before);
    const mcp = await wire(app, run.players[0]!.mcp_url, 'tools/call', {
      name: 'get_status',
      arguments: { after_cursor: first.next_cursor },
    });
    expect(mcp.body.result.structuredContent).toEqual({ ok: true, ...last });
  }, 20_000);
  it('advances status cursors over hidden Beer orders without revealing another role', async () => {
    const { seats } = await createBeerSimulation();
    const initial = await store.playerStatus(seats[0]!, null);
    const action = await store.playerActions(seats[1]!);
    await store.submitAction(seats[1]!, action.turn_id!, 'beer.order', { quantity: 4 });
    const next = await store.playerStatus(seats[0]!, initial.next_cursor);
    expect(next).toMatchObject({
      state: 'action_required',
      turn_id: initial.turn_id,
      info: { week: 1 },
      updates: [],
      has_more: false,
    });
    expect(next.next_cursor).not.toBe(initial.next_cursor);
    for (const field of ['rules', 'pokerBReward', 'previousRotationResult'])
      expect(next.info).not.toHaveProperty(field);
    expect(next).not.toHaveProperty('players');
    expect(await store.playerStatus(seats[0]!, next.next_cursor)).toEqual(next);
  });
  it('keeps status and its cursor on one snapshot across a concurrent action', async () => {
    const { seats } = await createGame();
    const statuses = await Promise.all(seats.map((seat) => store.playerStatus(seat)));
    const index = statuses.findIndex(({ state }) => state === 'action_required');
    const actor = seats[index]!;
    const initial = statuses[index]!;
    const choice = await store.playerActions(actor);
    let committed = false;
    interleave('WITH status_events', async () => {
      await store.submitAction(actor, choice.turn_id!, 'poker.fold');
      committed = true;
    });
    const current = await store.playerStatus(actor, initial.next_cursor);
    expect(committed).toBe(true);
    expect(current).toMatchObject({
      state: initial.state,
      turn_id: initial.turn_id,
      next_cursor: initial.next_cursor,
      updates: [],
    });
    const next = await store.playerStatus(actor, current.next_cursor);
    expect(next.next_cursor).not.toBe(current.next_cursor);
    expect(next.updates).toMatchObject([
      { kind: 'poker_action', data: { actor: actor.playerId, action: { id: 'fold' } } },
    ]);
    expect(next.turn_id).not.toBe(initial.turn_id);
  });
  it('rejects a string-valued MCP raise without writing state or evidence', async () => {
    const run = await store.createSimulation(creation, new URL(operatorUrl));
    const options = await Promise.all(
      run.players.map(async ({ mcp_url }) => ({
        url: mcp_url,
        ...(await wire(app, mcp_url, 'tools/call', { name: 'get_actions', arguments: {} })).body
          .result.structuredContent,
      })),
    );
    const actor = options.find(({ actions }) =>
      actions.some(({ action_id }: any) => action_id === 'poker.raise'),
    )!;
    const raise = actor.actions.find(({ action_id }: any) => action_id === 'poker.raise');
    const input = {
      turn_id: actor.turn_id,
      action_id: raise.action_id,
      parameters: raise.exampleParameters,
    };
    const before = await store.exportSimulation(run.simulation_id);
    const rejected = await wire(app, actor.url, 'tools/call', {
      name: 'submit_action',
      arguments: { ...input, parameters: { to: String(input.parameters.to) } },
    });
    expect(rejected.body.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'ILLEGAL_ACTION' },
    });
    expect(await store.exportSimulation(run.simulation_id)).toEqual(before);
    const accepted = await wire(app, actor.url, 'tools/call', {
      name: 'submit_action',
      arguments: input,
    });
    expect(accepted.body.result.structuredContent).toMatchObject({
      ok: true,
      accepted: true,
      replayed: false,
    });
    const after = await store.exportSimulation(run.simulation_id);
    expect(after.manifest.state_version).toBe('1');
    expect(after.manifest.state_hash).not.toBe(before.manifest.state_hash);
    expect(after.events.filter(({ kind }) => kind === 'action')).toMatchObject([
      { payload: { request: { action_id: 'poker.raise', parameters: input.parameters } } },
    ]);
  });
  it('keeps concurrent Beer turns stable, unique, replayable, and week-scoped', async () => {
    const { run, seats } = await createBeerSimulation();
    const statuses = await Promise.all(seats.map((seat) => store.playerStatus(seat)));
    expect(new Set(statuses.map(({ turn_id }) => turn_id)).size).toBe(8);
    for (const [index, seat] of seats.entries())
      expect((await store.playerActions(seat)).turn_id).toBe(statuses[index]!.turn_id);
    interleave(
      'WITH advanced',
      () => store.submitAction(seats[1]!, statuses[1]!.turn_id!, 'beer.order', { quantity: 4 }),
      true,
    );
    await rejects(
      store.submitAction(seats[0]!, statuses[0]!.turn_id!, 'beer.order', { quantity: 4 }),
      'BUSY',
    );
    expect((await store.exportSimulation(run.simulation_id)).events).toHaveLength(1);
    expect(await store.getSimulation(run.simulation_id)).toMatchObject({ state_version: '1' });
    expect((await store.playerActions(seats[0]!)).turn_id).toBe(statuses[0]!.turn_id);
    await Promise.all(
      seats.map((seat, index) =>
        expect(
          submit(seat, statuses[index]!.turn_id!, 'beer.order', { quantity: 4 }),
        ).resolves.toMatchObject({ accepted: true, replayed: index === 1 }),
      ),
    );
    await expect(
      store.submitAction(seats[0]!, statuses[0]!.turn_id!, 'beer.order', { quantity: 4 }),
    ).resolves.toMatchObject({ accepted: true, replayed: true });
    const next = await store.playerStatus(seats[0]!);
    expect(next).toMatchObject({
      state: 'action_required',
      can_send_message: false,
      info: { rotation: 1, week: 2 },
    });
    expect(next.turn_id).not.toBe(statuses[0]!.turn_id);
    let weekTwo = newBeer();
    for (const player of players) weekTwo = applyBeerOrder(weekTwo, player, 4, config.beer).state;
    const advanced = await createBeerSimulation(weekTwo);
    await rejects(
      store.submitAction(advanced.seats[0]!, statuses[0]!.turn_id!, 'beer.order', { quantity: 4 }),
      'STALE_TURN',
    );
  });
  it('keeps prior messages readable during Beer while sending is disabled', async () => {
    const { run, seats } = await createGame();
    await store.sendMessage(seats[0]!, seats[1]!.playerId, 'Before Beer');
    await setBeer(run);
    const inbox = await wire(app, run.players[1]!.mcp_url, 'tools/call', {
      name: 'read_inbox',
      arguments: {},
    });
    expect(inbox.body.result.structuredContent.messages).toMatchObject([{ text: 'Before Beer' }]);
    expect((await store.playerStatus(seats[1]!)).unread_messages).toBe(0);
    await rejects(store.sendMessage(seats[1]!, 'all', 'During Beer'), 'MESSAGE_NOT_ALLOWED');
  });
  it('durably tracks unread direct and broadcast messages with paginated cursor isolation', async () => {
    const { run, seats } = await createGame();
    const statuses = await Promise.all(seats.map((seat) => store.playerStatus(seat)));
    const receiver = seats.find(
      (seat) =>
        seat.playerId === statuses.find(({ state }) => state === 'action_required')!.player_id,
    )!;
    const sender = seats.find((seat) => seat.playerId !== receiver.playerId)!;
    const other = seats.find(
      (seat) => seat.playerId !== receiver.playerId && seat.playerId !== sender.playerId,
    )!;
    expect(await store.playerStatus(receiver)).toMatchObject({
      state: 'action_required',
      unread_messages: 0,
      message_guidance: 'You have no unread messages.',
    });
    await expect(store.sendMessage(sender, receiver.playerId, 'direct')).resolves.toMatchObject({
      delivered: 1,
    });
    await expect(store.sendMessage(sender, 'all', 'broadcast')).resolves.toMatchObject({
      delivered: 7,
    });
    const counts = await Promise.all(
      [sender, receiver, other].map((seat) => store.playerStatus(seat)),
    );
    expect(counts.map(({ unread_messages }) => unread_messages)).toEqual([0, 2, 1]);
    expect(counts[1]!.message_guidance).toBe(
      'You have 2 unread messages. Call `read_inbox` before choosing your action.',
    );
    for (let index = 0; index < 50; index++)
      await store.sendMessage(sender, receiver.playerId, `page-${index}`);
    const cursor = async () =>
      String(
        (
          await pool.query(
            `SELECT inbox_read_cursor FROM seats WHERE simulation_id=$1 AND seat=$2`,
            [run.simulation_id, receiver.seat],
          )
        ).rows[0].inbox_read_cursor,
      );
    const first = await store.readInbox(receiver);
    expect(first.messages).toHaveLength(50);
    expect(first.messages.slice(0, 2).map((message: any) => message.text)).toEqual([
      'direct',
      'broadcast',
    ]);
    expect(first.has_more).toBe(true);
    expect(await cursor()).toBe(first.next_cursor);
    expect((await store.playerStatus(receiver)).unread_messages).toBe(2);
    const inbox = await store.readInbox(receiver, first.next_cursor);
    expect(inbox.messages).toHaveLength(2);
    expect(inbox.has_more).toBe(false);
    expect(await cursor()).toBe(inbox.next_cursor);
    expect((await store.playerStatus(receiver)).unread_messages).toBe(0);
    expect((await store.playerStatus(other)).unread_messages).toBe(1);
    expect((await store.readInbox(sender)).messages).toEqual([]);
    expect((await store.readInbox(receiver, inbox.next_cursor)).messages).toEqual([]);
    expect((await store.readInbox(receiver, '0')).messages).toHaveLength(50);
    expect((await store.playerStatus(receiver)).unread_messages).toBe(0);
    for (const [operation, code] of [
      [() => store.sendMessage(sender, sender.playerId, 'self'), 'SELF_MESSAGE'],
      [() => store.sendMessage(sender, 'nobody', 'unknown'), 'UNKNOWN_RECIPIENT'],
      [() => store.sendMessage(sender, receiver.playerId, ''), 'MESSAGE_TOO_LONG'],
      [() => store.sendMessage(sender, receiver.playerId, '🍺'.repeat(161)), 'MESSAGE_TOO_LONG'],
      [() => store.readInbox(receiver, '9223372036854775808'), 'BAD_CURSOR'],
    ] as const)
      await rejects(operation(), code);
    await expect(
      store.sendMessage(sender, receiver.playerId, '🍺'.repeat(160)),
    ).resolves.toMatchObject({ delivered: 1 });
    expect((await store.playerStatus(receiver)).unread_messages).toBe(1);
    interleave('WITH inbox', () =>
      store.sendMessage(sender, receiver.playerId, 'Arrived during read'),
    );
    expect((await store.readInbox(receiver)).messages).toHaveLength(1);
    expect((await store.playerStatus(receiver)).unread_messages).toBe(1);
    expect((await store.readInbox(receiver)).messages).toMatchObject([
      { text: 'Arrived during read' },
    ]);
    const racing = await createGame();
    interleave('WITH current', () => setBeer(racing.run), true);
    await rejects(store.sendMessage(racing.seats[0]!, 'all', 'raced'), 'BUSY');
    expect((await store.exportSimulation(racing.run.simulation_id)).events).toEqual([]);
    await rejects(store.sendMessage(racing.seats[0]!, 'all', 'blocked'), 'MESSAGE_NOT_ALLOWED');
  });
  it('returns exact recipient IDs for failed DMs without delivering or exposing biographies', async () => {
    const runPlayers = descriptors.map((player, index) => ({
      ...player,
      id: index === 1 ? '李彥宏' : player.id,
    }));
    const { run, seats } = await createGame(runPlayers);
    const call = (to: string) =>
      wire(app, run.players[0]!.mcp_url, 'tools/call', {
        name: 'send_message',
        arguments: { to, text: 'Team up?' },
      });
    const failed = (await call('李彦宏')).body.result;
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_RECIPIENT' },
    });
    const message = failed.structuredContent.error.message;
    expect(message).toContain(JSON.stringify(runPlayers.slice(1).map(({ id }) => id)));
    expect(message).toContain('do not switch to "all"');
    for (const player of runPlayers) {
      expect(message).not.toContain(player.publicBiography);
      expect(message).not.toContain(player.privateBiography);
    }
    expect(
      await Promise.all(
        seats.map(async (seat) => (await store.playerStatus(seat!)).unread_messages),
      ),
    ).toEqual(Array(8).fill(0));
    expect((await call('李彥宏')).body.result.structuredContent).toMatchObject({
      ok: true,
      accepted: true,
      delivered: 1,
    });
    expect(
      await Promise.all(
        seats.map(async (seat) => (await store.playerStatus(seat!)).unread_messages),
      ),
    ).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
  });
  it('exports ordered evidence without any capability', async () => {
    const query = vi.spyOn(store, 'query');
    const exported = await store.exportSimulation(created.simulation_id);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(exported.events.length).toBeGreaterThan(0);
    expect(exported.manifest.config).toMatchObject({
      version: 2,
      id: config.id,
      players: descriptors,
      messaging: config.messaging,
      poker: config.poker,
      beer: { demandPack: { mode: 'static' }, demand: config.beer.demand },
    });
    expect(exported.result).toMatchObject({ valid: false, status: 'running' });
    expect(
      sha256({
        configHash: exported.manifest.config_hash,
        version: Number(exported.manifest.state_version),
        snapshot: exported.snapshot,
      }),
    ).toBe(exported.manifest.state_hash);
    expect(exported.manifest.seats).toEqual(
      players.map((player_id, index) => ({ seat: index + 1, player_id })),
    );
    const text = JSON.stringify(exported);
    for (const seat of created.players) expect(text).not.toContain(secret(seat.mcp_url));
    expect(text).not.toContain(created.viewer.key);
  });
  it('keeps the observer snapshot, events, and unread counts coherent across a concurrent commit', async () => {
    const { run, seats } = await createGame();
    const choices = await Promise.all(seats.map((seat) => store.playerActions(seat)));
    const index = choices.findIndex(({ actions }) => actions.length);
    const choice = choices[index]!;
    let committed = false;
    interleave('FROM simulations s', async () => {
      committed = true;
      await store.submitAction(seats[index]!, choice.turn_id!, choice.actions[0]!.action_id);
      await store.sendMessage(seats[index]!, 'all', 'A message committed after the observer read.');
    });
    const view = await store.getViewerState(run.simulation_id, run.viewer.key);
    expect(committed).toBe(true);
    expect(view).not.toHaveProperty('snapshot');
    expect(view).toMatchObject({ version: 0, actions: [], messages: [] });
    expect(view.players.every(({ unread_messages }) => unread_messages === 0)).toBe(true);
    const latest = await store.getSimulationState(run.simulation_id);
    expect(latest.version).toBe(1);
    expect(latest.actions).toHaveLength(1);
    expect(latest.messages).toHaveLength(7);
    expect(latest.players.map(({ unread_messages }) => unread_messages).sort()).toEqual([
      0, 1, 1, 1, 1, 1, 1, 1,
    ]);
    await store.readInbox(seats[(index + 1) % 8]!);
    expect(
      (await store.getSimulationState(run.simulation_id)).players[(index + 1) % 8]!.unread_messages,
    ).toBe(0);
  });
  it('isolates simultaneous Beer orders for two simulations with identical turn IDs', async () => {
    const games = await Promise.all([createBeerSimulation(), createBeerSimulation()]);
    await Promise.all(
      games.map(async ({ run, seats }) => {
        const choices = await Promise.all(seats.map((seat) => store.playerActions(seat)));
        await Promise.all(
          seats.map((seat, index) =>
            submit(seat, choices[index]!.turn_id!, 'beer.order', { quantity: 4 }),
          ),
        );
        expect(await store.getSimulation(run.simulation_id)).toMatchObject({
          state_version: '8',
          stage: 'beer',
        });
        const statuses = await Promise.all(seats.map((seat) => store.playerStatus(seat)));
        expect(statuses.every(({ info }) => (info as { week: number }).week === 2)).toBe(true);
        const events = (await store.exportSimulation(run.simulation_id)).events;
        expect(events).toHaveLength(8);
        expect(events.every(({ simulation_id }) => simulation_id === run.simulation_id)).toBe(true);
      }),
    );
  });
  it('accepts a maximum-length Beer turn through MCP without changing its identity', async () => {
    const runPlayers = descriptors.map((player, index) => ({
      ...player,
      id: `${index}${'p'.repeat(199)}`,
    }));
    const ids = runPlayers.map(({ id }) => id);
    let beer = createBeer(
      [ids[0]!, ids[4]!],
      { [ids[0]!]: ids.slice(0, 4), [ids[4]!]: ids.slice(4) },
      config.beer,
    );
    for (let week = 1; week < 10; week++)
      for (const id of ids) beer = applyBeerOrder(beer, id, 4, config.beer).state;
    const { run } = await createBeerSimulation(beer, runPlayers);
    const url = run.players[0]!.mcp_url;
    const choices = (await wire(app, url, 'tools/call', { name: 'get_actions', arguments: {} }))
      .body.result.structuredContent;
    expect(choices.turn_id).toBe(`beer:1:10:${ids[0]}`);
    expect(choices.turn_id).toHaveLength(210);
    const submitted = await wire(app, url, 'tools/call', {
      name: 'submit_action',
      arguments: { turn_id: choices.turn_id, action_id: 'beer.order', parameters: { quantity: 4 } },
    });
    expect(submitted.body.result.structuredContent).toMatchObject({
      ok: true,
      accepted: true,
      replayed: false,
    });
  });
  it('keeps player identity bound to its MCP URL across actions and messaging', async () => {
    const run = await store.createSimulation(creation, new URL(operatorUrl));
    const call = async (
      url: string,
      name: string,
      args: object = name === 'get_status' ? { after_cursor: null } : {},
    ) => (await wire(app, url, 'tools/call', { name, arguments: args })).body;
    const statuses = await Promise.all(
      run.players.map(({ mcp_url }) => call(mcp_url, 'get_status')),
    );
    const index = statuses.findIndex(
      ({ result }) => result.structuredContent.state === 'action_required',
    );
    const actor = run.players[index]!;
    const other = run.players[(index + 1) % 8]!;
    const player =
      (url: string) =>
      async (name: string, args: object = {}) =>
        (await call(url, name, args)).result.structuredContent;
    const own = player(actor.mcp_url);
    const peer = player(other.mcp_url);
    for (const [name, args] of [
      ['get_rules', []],
      ['get_status', []],
      ['get_actions', []],
      ['submit_action', { turn_id: 'x' }],
      ['read_inbox', { after_cursor: 'invalid' }],
      ['send_message', { to: false, text: 'invalid' }],
    ] as const) {
      const invalid = await call(other.mcp_url, name, args);
      expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    }
    const choices = await own('get_actions');
    const action = {
      turn_id: choices.turn_id,
      action_id: choices.actions[0].action_id,
      player_id: actor.player_id,
    };
    expect((await peer('submit_action', action)).error.code).toBe('NOT_YOUR_TURN');
    expect((await own('submit_action', { ...action, action_id: 'invalid' })).error.code).toBe(
      'ILLEGAL_ACTION',
    );
    expect((await own('submit_action', action)).accepted).toBe(true);
    expect(
      (await peer('get_status', { after_cursor: null, player_id: actor.player_id })).player_id,
    ).toBe(other.player_id);
    expect(
      (await call(other.mcp_url, 'export_simulation', { simulation_id: run.simulation_id })).error,
    ).toBeDefined();
    expect(
      (await own('send_message', { to: other.player_id, text: 'private message' })).delivered,
    ).toBe(1);
    expect((await peer('read_inbox')).messages).toMatchObject([
      { from: actor.player_id, text: 'private message' },
    ]);
    expect((await own('read_inbox')).messages).toEqual([]);
    expect((await peer('read_inbox', { after_cursor: '9223372036854775808' })).error.code).toBe(
      'BAD_CURSOR',
    );
    const beer = await createBeerSimulation();
    expect(
      (await player(beer.run.players[0]!.mcp_url)('send_message', { to: 'all', text: 'blocked' }))
        .error.code,
    ).toBe('MESSAGE_NOT_ALLOWED');
  });
});
