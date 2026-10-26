-- Roblox Live Operations Console: persistent public telemetry only.
CREATE TABLE IF NOT EXISTS monitored_games (
  place_id TEXT PRIMARY KEY NOT NULL,
  universe_id TEXT,
  name TEXT NOT NULL,
  creator_name TEXT,
  creator_id TEXT,
  is_playable INTEGER,
  last_seen INTEGER NOT NULL,
  last_playing INTEGER,
  max_players INTEGER,
  visits INTEGER
);

CREATE TABLE IF NOT EXISTS game_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL,
  universe_id TEXT,
  game_name TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  playing INTEGER,
  max_players INTEGER,
  visits INTEGER,
  is_playable INTEGER
);
CREATE INDEX IF NOT EXISTS idx_game_snapshots_place_sampled ON game_snapshots(place_id, sampled_at);
CREATE INDEX IF NOT EXISTS idx_game_snapshots_sampled ON game_snapshots(sampled_at);

-- Store a short-lived keyed hash instead of the visitor's raw IP address.
CREATE TABLE IF NOT EXISTS request_limits (
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
CREATE INDEX IF NOT EXISTS idx_request_limits_window ON request_limits(window_start);
