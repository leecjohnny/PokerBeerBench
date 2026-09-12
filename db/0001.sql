SELECT pg_advisory_xact_lock(907525011007);
CREATE TABLE IF NOT EXISTS simulations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  viewer_capability_hash text NOT NULL UNIQUE CHECK (viewer_capability_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS seats (
  simulation_id text NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 8),
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  capability_hash text NOT NULL UNIQUE CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  inbox_read_cursor bigint NOT NULL DEFAULT 0 CHECK (inbox_read_cursor >= 0),
  PRIMARY KEY (simulation_id, seat),
  UNIQUE (simulation_id, player_id)
);
ALTER TABLE seats ADD COLUMN IF NOT EXISTS inbox_read_cursor bigint NOT NULL DEFAULT 0 CHECK (inbox_read_cursor >= 0);
CREATE TABLE IF NOT EXISTS arena_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  simulation_id text NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('action', 'milestone', 'message')), stage text NOT NULL,
  actor_seat smallint, recipient_seat smallint, turn_id text, message_id text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (simulation_id, actor_seat) REFERENCES seats(simulation_id, seat),
  FOREIGN KEY (simulation_id, recipient_seat) REFERENCES seats(simulation_id, seat),
  CHECK (
    (kind = 'action' AND actor_seat IS NOT NULL AND recipient_seat IS NULL AND turn_id IS NOT NULL AND message_id IS NULL)
    OR
    (kind = 'milestone' AND actor_seat IS NULL AND recipient_seat IS NULL AND turn_id IS NULL AND message_id IS NULL)
    OR
    (kind = 'message' AND actor_seat IS NOT NULL AND recipient_seat IS NOT NULL
      AND message_id IS NOT NULL AND turn_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS arena_events_turn_uq ON arena_events(simulation_id, turn_id) WHERE kind = 'action' AND turn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS arena_events_delivery_uq ON arena_events(simulation_id, message_id, recipient_seat) WHERE kind = 'message';
CREATE INDEX IF NOT EXISTS arena_events_export_idx ON arena_events(simulation_id, event_id); CREATE INDEX IF NOT EXISTS arena_events_milestone_idx ON arena_events(simulation_id, event_id) WHERE kind = 'milestone';
CREATE INDEX IF NOT EXISTS arena_events_inbox_idx ON arena_events(simulation_id, recipient_seat, event_id) WHERE kind = 'message';
