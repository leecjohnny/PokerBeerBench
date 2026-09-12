import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon, type NeonQueryFunction, type NeonQueryPromise } from '@neondatabase/serverless';
import {
  applyTournament,
  createTournament,
  tournamentActions,
  tournamentCanMessage,
  tournamentHistory,
  tournamentResult,
  tournamentStatus,
  type TournamentHistory,
  type TournamentState,
} from '../game/tournament.js';
import { maxBeerOrder } from '../game/beer.js';
import { compactInfo, statusUpdates, type StatusEvent } from './status.js';
import {
  biographyProjection,
  canonical,
  configSchema,
  playerIds,
  resolveCreation,
  roles,
  sha256,
  traceCapability,
  type BenchmarkConfig,
} from '../shared.js';
const POLL_MS = 30_000;
export interface SeatIdentity {
  simulationId: string;
  seat: number;
  playerId: string;
}
type SimRow = {
  id: string;
  state_version: string;
  config: BenchmarkConfig;
  config_hash: string;
  viewer_capability_hash: string;
  snapshot: TournamentState;
  state_hash: string;
  created_at: Date;
};
type SimulationEvidence = {
  simulation: SimRow;
  seats: { seat: number; player_id: string; inbox_read_cursor: string }[];
  events: any[];
};
type RecordedAction = { event_id: string; actor_seat: number; payload: any };
export class ArenaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
const json = (value: unknown) => JSON.stringify(value);
const cap = () => randomBytes(32).toString('base64url');
const stateHash = (configHash: string, version: number, snapshot: unknown) =>
  sha256({ configHash, version, snapshot });
const validate = (row: SimRow) => {
  row.config = configSchema.parse(row.config);
  const stage = row.snapshot.stage;
  const fields = ['poker', 'draft', 'beer'].filter((key) => key in row.snapshot);
  const expected =
    stage === 'poker_a' || stage === 'poker_b' ? 'poker' : stage === 'complete' ? undefined : stage;
  const version = Number(row.state_version);
  if (
    row.snapshot.version !== 1 ||
    !['poker_a', 'draft', 'beer', 'poker_b', 'complete'].includes(stage) ||
    fields.length !== (expected ? 1 : 0) ||
    fields[0] !== expected ||
    !Number.isSafeInteger(version) ||
    sha256(row.config) !== row.config_hash ||
    stateHash(row.config_hash, version, row.snapshot) !== row.state_hash
  )
    throw new ArenaError('CORRUPT', 'Simulation data is inconsistent.');
};
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
const normalizeEvents = (rows: any[]) =>
  rows.map(({ event_id, created_at, ...row }) => ({
    event_id: String(event_id),
    ...row,
    created_at: iso(created_at),
  }));
const actionTurnId = (simulation: SimRow, playerId: string, actionRequired: boolean) => {
  const beer = simulation.snapshot.stage === 'beer' ? simulation.snapshot.beer : undefined; // Beer turns are concurrent semantic weeks.
  return !actionRequired
    ? null
    : beer
      ? `beer:${beer.rotation}:${beer.week}:${playerId}`
      : simulation.state_version;
};
const playerProjection = (
  simulation: SimRow,
  playerId: string,
  history: TournamentHistory = {},
  unread = 0,
) => {
  const status = tournamentStatus(simulation.snapshot, simulation.config, playerId, history);
  const state = status.complete
    ? 'complete'
    : status.actionRequired
      ? 'action_required'
      : 'waiting';
  return {
    simulation_id: simulation.id,
    player_id: playerId,
    stage: status.stage,
    state,
    turn_id: actionTurnId(simulation, playerId, state === 'action_required'),
    ...(state === 'waiting' ? { retry_after_ms: POLL_MS } : {}),
    unread_messages: unread,
    ...(state === 'action_required'
      ? {
          message_guidance: unread
            ? `You have ${unread} unread messages. Call \`read_inbox\` before choosing your action.`
            : 'You have no unread messages.',
        }
      : {}),
    info: status.view,
    players: biographyProjection(simulation.config, playerId),
    can_send_message: status.canSendMessage,
  };
};
export class ArenaStore {
  readonly sql: NeonQueryFunction<false, false>;
  constructor(
    databaseUrl: string,
    readonly profile: BenchmarkConfig,
  ) {
    this.sql = neon(databaseUrl);
  }
  async migrate() {
    const statements = (await readFile(`${process.cwd()}/db/0001.sql`, 'utf8')).split(';');
    await this.batch(statements.filter((sql) => sql.trim()).map((sql) => this.sql.query(sql)));
  }
  async resolveCapability(hash: string): Promise<SeatIdentity | null> {
    const row = (
      await this.query<{ simulation_id: string; seat: number; player_id: string }>(
        `SELECT simulation_id, seat, player_id FROM seats WHERE capability_hash = $1`,
        [hash],
      )
    )[0];
    return row
      ? { simulationId: row.simulation_id, seat: row.seat, playerId: row.player_id }
      : null;
  }
  async createSimulation(raw: unknown, operatorUrl: URL) {
    const config = resolveCreation(raw, this.profile, cap());
    const maximum = maxBeerOrder(config.beer);
    if (config.beer.demand.flat().some((value) => value > maximum))
      throw new ArenaError('INVALID_CONFIG', `Beer demand exceeds safe maximum ${maximum}.`);
    const id = randomUUID();
    const snapshot = createTournament(config);
    const configHash = sha256(config);
    const hash = stateHash(configHash, 0, snapshot);
    const ids = playerIds(config);
    const capabilities = ids.map(() => cap());
    const viewer = cap();
    await this.query(
      `WITH created AS (
         INSERT INTO simulations(id,config,config_hash,viewer_capability_hash,snapshot,state_hash)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id
       ) INSERT INTO seats(simulation_id,seat,player_id,capability_hash)
       SELECT created.id,ordinality::smallint,player_id,capability_hash FROM created,
         unnest($7::text[],$8::text[]) WITH ORDINALITY AS seat(player_id,capability_hash,ordinality)`,
      [
        id,
        json(config),
        configHash,
        sha256(viewer),
        json(snapshot),
        hash,
        ids,
        capabilities.map(sha256),
      ],
    );
    return {
      simulation_id: id,
      players: ids.map((player_id, index) => ({
        player_id,
        mcp_url: new URL(capabilities[index]!, operatorUrl).toString(),
      })),
      viewer: { key: viewer, url: new URL(`/simulations/${id}`, operatorUrl).href },
    };
  }
  async playerStatus(identity: SeatIdentity, after: string | null = null) {
    const prefix = `${identity.simulationId}/${identity.seat}/`;
    const cursor = after?.startsWith(prefix) ? after.slice(prefix.length) : after;
    if (
      after !== null &&
      (!after.startsWith(prefix) ||
        !/^\d{1,19}$/.test(cursor!) ||
        BigInt(cursor!) > 9_223_372_036_854_775_807n)
    )
      throw new ArenaError(
        'BAD_CURSOR',
        "Use this seat's next_cursor, or after_cursor:null for a full refresh.",
      );
    const simulation = (
      await this.query<
        SimRow & { unread: number; latest: string; milestones: StatusEvent[]; page: StatusEvent[] }
      >(
        `WITH status_events AS NOT MATERIALIZED (
         SELECT * FROM arena_events WHERE simulation_id=$1 AND kind<>'message'
       ) SELECT s.*,s.state_version::text,
         COALESCE((SELECT max(event_id) FROM status_events),0)::text latest,
         COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('event_id',event_id::text) ORDER BY event_id)
           FROM status_events e WHERE kind='milestone'),'[]') milestones,
         COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('event_id',event_id::text) ORDER BY event_id)
           FROM (SELECT * FROM status_events WHERE $3::bigint IS NOT NULL AND event_id>$3 ORDER BY event_id LIMIT 51) e),'[]') page,
         (SELECT count(*)::int FROM arena_events e JOIN seats p ON p.simulation_id=e.simulation_id AND p.seat=e.recipient_seat
           WHERE p.simulation_id=$1 AND p.seat=$2 AND e.kind='message' AND e.event_id>p.inbox_read_cursor) unread
       FROM simulations s WHERE s.id=$1`,
        [identity.simulationId, identity.seat, cursor],
      )
    )[0];
    if (!simulation) throw new ArenaError('NOT_FOUND', 'Unknown simulation.');
    validate(simulation);
    if (cursor !== null && BigInt(cursor!) > BigInt(simulation.latest))
      throw new ArenaError(
        'BAD_CURSOR',
        'Cursor is ahead of the simulation; use after_cursor:null.',
      );
    const page = simulation.page.slice(0, 50);
    const history = tournamentHistory(simulation.milestones.map((row) => row.payload));
    const { players, ...status } = playerProjection(
      simulation,
      identity.playerId,
      history,
      simulation.unread,
    );
    const teams =
      simulation.snapshot.stage === 'beer'
        ? simulation.snapshot.beer.teams
        : (simulation.milestones.find((row) => row.stage === 'beer')?.payload.teams ?? {});
    return {
      ...status,
      ...(after === null ? { players } : {}),
      info: after === null ? status.info : compactInfo(status.info),
      updates: statusUpdates(page, identity.playerId, teams, simulation.config.beer).map(
        (update) => ({ ...update, cursor: prefix + update.cursor }),
      ),
      has_more: simulation.page.length > 50,
      next_cursor:
        prefix + (after === null ? simulation.latest : (page.at(-1)?.event_id ?? cursor)),
    };
  }
  async playerRules(identity: SeatIdentity) {
    const { config } = await this.simulation(identity.simulationId);
    const blind = (level: BenchmarkConfig['poker']['blindSchedule'][number]) => ({
      small_blind: level[0],
      big_blind: level[1],
      big_blind_ante: level[2],
      hands: level[3],
    });
    const schedule = config.poker.blindSchedule;
    return {
      stage_sequence: ['Poker A', 'Draft', 'Beer', 'Poker B', 'Complete'],
      poker_a: {
        objective:
          'Be the last player with chips in an eight-player no-limit Texas Holdem freezeout.',
        scoring: '9 - final place.',
        actions: ['fold', 'check', 'call', 'bet', 'raise', 'all-in'],
        legal_actions: 'Only the current options returned by get_actions may be submitted.',
        starting_stack: config.poker.startingStack,
        blind_schedule: {
          levels: schedule.length,
          first: blind(schedule[0]!),
          last: blind(schedule.at(-1)!),
          hands_per_level: [...new Set(schedule.map((level) => level[3]))],
        },
      },
      draft: {
        objective: 'Create two teams of four for Beer.',
        scoring: 'No separate score; Poker A determines draft control.',
        entry:
          'Poker A ends at one survivor; that winner chooses first-pick privilege or the opposing captain.',
        selection:
          'If the winner takes first pick the other captain is drawn; if the winner chooses the other captain the first picker is drawn. Captains then alternate teammate picks.',
        actions: ['draft.first_pick', 'draft.choose_captain', 'draft.pick'],
      },
      beer: {
        objective: 'Minimize team cumulative holding plus backlog cost.',
        scoring: 'The lowest total cost across all rotations wins; tied lowest-cost teams all win.',
        rotations: config.beer.demand.length,
        weeks_per_rotation: config.beer.demand[0]!.length,
        roles: [...roles],
        role_rotation: 'Each player serves once in every role.',
        costs: { holding: config.beer.holdingCost, backlog: config.beer.backlogCost },
        delays: {
          order: config.beer.orderDelayWeeks,
          shipping: config.beer.shippingDelayWeeks,
          factory_request: config.beer.factoryRequestDelayWeeks,
          factory_production: config.beer.factoryProductionDelayWeeks,
        },
        warmup: {
          weeks: config.beer.warmupWeeks,
          required_order: config.beer.initialPipelineQuantity,
        },
        action: {
          name: 'beer.order',
          quantity: `exactly ${config.beer.initialPipelineQuantity} in warmup; then an integer 0-${maxBeerOrder(config.beer)}`,
        },
        poker_b_advantage: `Every player on a winning team starts Poker B with ${config.poker.finalWinnerStackMultiplier}x the normal stack.`,
      },
      poker_b: {
        objective: 'Be the last player with chips.',
        completion: 'Ends when one player retains chips.',
        scoring:
          '9 - final place; a valid tournament returns the highest Poker B score, otherwise 0.',
        actions: ['fold', 'check', 'call', 'bet', 'raise', 'all-in'],
        legal_actions: 'Only the current options returned by get_actions may be submitted.',
      },
      complete: {
        objective: 'Terminal evidence and results only.',
        scoring: 'Final placements and scores come from Poker B.',
      },
      messaging: {
        tools: ['read_inbox', 'send_message'],
        availability: 'Read inbox anytime. Send only during Poker A, Draft, and Poker B.',
        direct: 'Use a player ID in `to`.',
        broadcast: 'Use "all" in `to`.',
        character_limit: config.messaging.characterLimit,
      },
      milestones: [
        { from: 'Poker A', to: 'Draft', when: 'Poker A has one survivor.' },
        { from: 'Draft', to: 'Beer', when: 'Both teams contain four players.' },
        { from: 'Beer', to: 'Poker B', when: 'All four 50-week rotations finish.' },
        { from: 'Poker B', to: 'Complete', when: 'Poker B has one survivor.' },
      ],
    };
  }
  async playerActions(identity: SeatIdentity) {
    const simulation = await this.simulation(identity.simulationId);
    const actions = tournamentActions(
      simulation.snapshot,
      simulation.config,
      identity.playerId,
    ).map(({ actionId: action_id, ...action }) => ({ action_id, ...action }));
    const actionRequired = actions.length > 0;
    return {
      turn_id: actionTurnId(simulation, identity.playerId, actionRequired),
      actions,
      ...(!actionRequired && simulation.snapshot.stage !== 'complete'
        ? { retry_after_ms: POLL_MS }
        : {}),
    };
  }
  async submitAction(
    identity: SeatIdentity,
    turnId: string,
    actionId: string,
    parameters: Record<string, unknown> = {},
  ) {
    const request = { action_id: actionId, parameters };
    const simulation = await this.simulation(identity.simulationId, turnId);
    const existing = simulation.previous_action;
    if (existing) {
      if (
        existing.actor_seat !== identity.seat ||
        canonical(existing.payload.request) !== canonical(request)
      )
        throw new ArenaError('CONFLICT', 'That turn already accepted a different action.');
      return {
        accepted: true,
        replayed: true,
        event_id: existing.event_id,
        action: existing.payload.request,
      };
    }
    if (simulation.snapshot.stage === 'complete')
      throw new ArenaError('COMPLETE', 'The simulation is not running.');
    const beforeActions = tournamentActions(
      simulation.snapshot,
      simulation.config,
      identity.playerId,
    );
    if (!beforeActions.length)
      throw new ArenaError('NOT_YOUR_TURN', 'No action is required from this player.');
    if (actionTurnId(simulation, identity.playerId, true) !== turnId)
      throw new ArenaError('STALE_TURN', 'Refresh status and actions.');
    let applied;
    try {
      applied = applyTournament(simulation.snapshot, simulation.config, identity.playerId, {
        actionId,
        parameters,
      });
    } catch (error) {
      throw new ArenaError(
        'ILLEGAL_ACTION',
        error instanceof Error ? error.message : 'Illegal action.',
      );
    }
    const version = Number(simulation.state_version) + 1;
    const hash = stateHash(simulation.config_hash, version, applied.state);
    const milestones = applied.effects.filter((effect) => effect.kind === 'milestone');
    const effects = applied.effects.filter((effect) => effect.kind !== 'milestone');
    const inserted = (
      await this.query<{ event_id: string }>(
        `WITH advanced AS (
           UPDATE simulations SET state_version=$2,snapshot=$3,state_hash=$4
           WHERE id=$1 AND state_version=$5 RETURNING id
         ), committed AS (
           INSERT INTO arena_events(simulation_id,kind,stage,actor_seat,turn_id,payload)
           SELECT id,'action',$6,$7,$8,$9 FROM advanced RETURNING simulation_id,event_id
         ), milestones AS (
           INSERT INTO arena_events(simulation_id,kind,stage,payload)
           SELECT simulation_id,'milestone',data->>'stage',data
           FROM committed,jsonb_array_elements($10::jsonb) WITH ORDINALITY AS m(data,position)
           ORDER BY position
         ) SELECT event_id::text FROM committed`,
        [
          identity.simulationId,
          version,
          json(applied.state),
          hash,
          simulation.state_version,
          simulation.snapshot.stage,
          identity.seat,
          turnId,
          json({ request, effects, pre_state_hash: simulation.state_hash, post_state_hash: hash }),
          json(milestones.map(({ data }) => data)),
        ],
      )
    )[0];
    if (!inserted) throw new ArenaError('BUSY', 'Arena changed; retry shortly.', 500);
    return { accepted: true, replayed: false, event_id: inserted.event_id, action: request };
  }
  async readInbox(identity: SeatIdentity, after?: string) {
    if (
      after !== undefined &&
      (!/^\d{1,19}$/.test(after) || BigInt(after) > 9_223_372_036_854_775_807n)
    )
      throw new ArenaError('BAD_CURSOR', 'after_cursor must be a decimal cursor.');
    const page = (
      await this.query<{ messages: any[]; next_cursor: string; has_more: boolean }>(
        `WITH inbox AS (
         SELECT inbox_read_cursor FROM seats WHERE simulation_id=$1 AND seat=$2
       ), page AS MATERIALIZED (
         SELECT e.event_id,e.message_id,e.stage,s.player_id "from",
           e.payload->>'to' "to",e.payload->>'text' text,e.created_at
         FROM arena_events e JOIN seats s ON s.simulation_id=e.simulation_id AND s.seat=e.actor_seat
         WHERE e.simulation_id=$1 AND e.recipient_seat=$2 AND e.kind='message'
           AND e.event_id>COALESCE($3::bigint,(SELECT inbox_read_cursor FROM inbox))
         ORDER BY e.event_id LIMIT 51
       ), delivered AS MATERIALIZED (SELECT * FROM page ORDER BY event_id LIMIT 50), marked AS (
         UPDATE seats SET inbox_read_cursor=GREATEST(inbox_read_cursor,(SELECT max(event_id) FROM delivered))
         WHERE simulation_id=$1 AND seat=$2 AND EXISTS(SELECT 1 FROM delivered)
       ) SELECT COALESCE((SELECT jsonb_agg(to_jsonb(d)-'event_id'||jsonb_build_object('cursor',event_id::text)
           ORDER BY event_id) FROM delivered d),'[]') messages,
         COALESCE((SELECT max(event_id) FROM delivered),$3::bigint,inbox_read_cursor)::text next_cursor,
         (SELECT count(*) FROM page)>50 has_more FROM inbox`,
        [identity.simulationId, identity.seat, after ?? null],
      )
    )[0];
    if (!page) throw new ArenaError('NOT_FOUND', 'Unknown seat.');
    return {
      ...page,
      messages: page.messages.map((row) => ({ ...row, created_at: iso(row.created_at) })),
    };
  }
  async sendMessage(identity: SeatIdentity, to: string, text: string) {
    const simulation = await this.simulation(identity.simulationId);
    const length = Array.from(text).length;
    if (to === identity.playerId)
      throw new ArenaError('SELF_MESSAGE', 'Players cannot message themselves.');
    if (!tournamentCanMessage(simulation.snapshot.stage))
      throw new ArenaError('MESSAGE_NOT_ALLOWED', 'Messaging is unavailable in this stage.');
    if (length < 1 || length > simulation.config.messaging.characterLimit)
      throw new ArenaError(
        'MESSAGE_TOO_LONG',
        `Messages must contain 1-${simulation.config.messaging.characterLimit} characters.`,
      );
    if (to !== 'all' && !playerIds(simulation.config).includes(to))
      throw new ArenaError(
        'UNKNOWN_RECIPIENT',
        `Copy an exact recipient ID: ${JSON.stringify(playerIds(simulation.config).filter((id) => id !== identity.playerId))}. Correct the direct recipient; do not switch to "all" to bypass this error.`,
      );
    const messageId = randomUUID();
    // Serialize delivery allocation with commits so inbox cursors cannot skip a late lower ID.
    const delivered = (
      await this.query(
        `WITH current AS (
         SELECT id FROM simulations WHERE id=$1 AND snapshot->>'stage'=$2 FOR NO KEY UPDATE
       ) INSERT INTO arena_events(simulation_id,kind,stage,actor_seat,recipient_seat,message_id,payload)
         SELECT id,'message',$2,$3,seat,$4,$5 FROM current JOIN seats ON simulation_id=id
         WHERE seat<>$3 AND ($6='all' OR player_id=$6) RETURNING recipient_seat`,
        [
          identity.simulationId,
          simulation.snapshot.stage,
          identity.seat,
          messageId,
          json({ to, text }),
          to,
        ],
      )
    ).length;
    if (!delivered) throw new ArenaError('BUSY', 'Arena changed; retry shortly.', 500);
    return { accepted: true, message_id: messageId, delivered };
  }
  async getSimulation(id: string) {
    const row = await this.simulation(id);
    return {
      simulation_id: id,
      status: row.snapshot.stage === 'complete' ? 'completed' : 'running',
      stage: row.snapshot.stage,
      state_version: row.state_version,
      config_hash: row.config_hash,
      state_hash: row.state_hash,
    };
  }
  async getSimulationState(id: string) {
    return this.observer(await this.evidence(id));
  }
  async getViewerState(id: string, key: string) {
    if (!/^[A-Za-z0-9_-]{32,}$/.test(key))
      throw new ArenaError('NOT_FOUND', 'Simulation viewer not found.');
    return {
      ...this.observer(await this.evidence(id, sha256(key))),
      atif_url: `/atif_view/${traceCapability(id, key)}/`,
    };
  }
  private async evidence(id: string, viewerHash?: string): Promise<SimulationEvidence> {
    const row = (
      await this.query<SimulationEvidence>(
        `SELECT (to_jsonb(s)-'viewer_capability_hash')||jsonb_build_object('state_version',s.state_version::text) simulation,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('seat',seat,'player_id',player_id,'inbox_read_cursor',inbox_read_cursor::text) ORDER BY seat)
            FROM seats WHERE simulation_id=s.id),'[]') seats,
          COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('event_id',event_id::text) ORDER BY event_id)
            FROM arena_events e WHERE simulation_id=s.id),'[]') events
         FROM simulations s WHERE id=$1${viewerHash ? ' AND viewer_capability_hash=$2' : ''}`,
        viewerHash ? [id, viewerHash] : [id],
      )
    )[0];
    if (!row)
      throw new ArenaError(
        'NOT_FOUND',
        viewerHash ? 'Simulation viewer not found.' : 'Unknown simulation.',
      );
    validate(row.simulation);
    return { ...row, events: normalizeEvents(row.events) };
  }
  async exportSimulation(id: string) {
    const { simulation, seats, events } = await this.evidence(id);
    const milestones = events.filter(({ kind }) => kind === 'milestone');
    const history = tournamentHistory(milestones.map(({ payload }) => payload));
    const result = tournamentResult(history);
    const complete = simulation.snapshot.stage === 'complete';
    const updatedAt = events.at(-1)?.created_at ?? iso(simulation.created_at);
    const completedAt =
      milestones.find(({ payload }) => payload.stage === 'complete')?.created_at ?? null;
    return {
      manifest: {
        simulation_id: id,
        config: simulation.config,
        config_hash: simulation.config_hash,
        state_hash: simulation.state_hash,
        state_version: simulation.state_version,
        status: complete ? 'completed' : 'running',
        stage: simulation.snapshot.stage,
        created_at: iso(simulation.created_at),
        updated_at: updatedAt,
        completed_at: completedAt,
        seats: seats.map(({ seat, player_id }) => ({ seat, player_id })),
        evidence_hash: sha256(events),
      },
      result:
        complete && result
          ? { valid: true, ...result }
          : { valid: false, status: complete ? 'completed' : 'running' },
      snapshot: simulation.snapshot,
      events,
    };
  }
  private observer({ simulation, seats, events: rows }: SimulationEvidence) {
    const ids = playerIds(simulation.config);
    const milestones = rows.filter(({ kind }) => kind === 'milestone').map((row) => row.payload);
    const history = tournamentHistory(milestones);
    const projections = ids.map((playerId) => {
      const seat = seats.find(({ player_id }) => player_id === playerId);
      const unread = seat
        ? rows.filter(
            (row) =>
              row.kind === 'message' &&
              row.recipient_seat === seat.seat &&
              BigInt(row.event_id) > BigInt(seat.inbox_read_cursor),
          ).length
        : 0;
      return playerProjection(simulation, playerId, history, unread);
    });
    const actions = rows
      .filter(({ kind }) => kind === 'action')
      .map((row) => ({
        event_id: row.event_id,
        stage: row.stage,
        player_id: ids[row.actor_seat - 1],
        turn_id: row.turn_id,
        action: row.payload.request,
        created_at: row.created_at,
      }));
    const messages = rows
      .filter(({ kind }) => kind === 'message')
      .map((row) => ({
        event_id: row.event_id,
        message_id: row.message_id,
        stage: row.stage,
        from: ids[row.actor_seat - 1],
        recipient: ids[row.recipient_seat - 1],
        to: row.payload.to,
        text: row.payload.text,
        created_at: row.created_at,
      }));
    const complete = simulation.snapshot.stage === 'complete';
    return {
      simulation_id: simulation.id,
      status: complete ? 'completed' : 'running',
      stage: simulation.snapshot.stage,
      version: Number(simulation.state_version),
      config_hash: simulation.config_hash,
      ...(complete ? {} : { retry_after_ms: POLL_MS }),
      biographies: biographyProjection(simulation.config, null),
      players: projections,
      actions,
      milestones,
      messages,
      ...(complete ? { result: tournamentResult(history) } : {}),
    };
  }
  private async simulation(id: string, turnId?: string) {
    const row = (
      await this.query<SimRow & { previous_action: RecordedAction | null }>(
        `SELECT *,state_version::text,(SELECT to_jsonb(e)||jsonb_build_object('event_id',event_id::text)
         FROM arena_events e WHERE simulation_id=$1 AND kind='action' AND turn_id=$2) previous_action
         FROM simulations WHERE id=$1`,
        [id, turnId ?? null],
      )
    )[0];
    if (!row) throw new ArenaError('NOT_FOUND', 'Unknown simulation.');
    validate(row);
    return row;
  }
  async query<R = Record<string, any>>(text: string, values: unknown[] = []) {
    return (await this.batch([this.sql.query(text, values)]))[0] as R[];
  }
  private async batch(queries: NeonQueryPromise<false, false>[]) {
    try {
      const [, ...results] = await this.sql.transaction(
        [
          this.sql.query(
            `SELECT set_config('lock_timeout','400ms',true), set_config('statement_timeout','2000ms',true), set_config('idle_in_transaction_session_timeout','3000ms',true)`,
          ),
          ...queries,
        ],
        { fetchOptions: { signal: AbortSignal.timeout(2_500) } },
      );
      return results;
    } catch (error: any) {
      if (error?.code === '55P03' || error?.code === '57014')
        throw new ArenaError('BUSY', 'Arena is busy; retry shortly.', 500);
      throw error;
    }
  }
}
