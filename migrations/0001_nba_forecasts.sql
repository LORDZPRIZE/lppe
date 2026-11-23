CREATE TABLE IF NOT EXISTS nba_forecasts (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  market TEXT NOT NULL,
  model_version TEXT NOT NULL,
  player TEXT NOT NULL,
  team TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  slate_date TEXT NOT NULL,
  captured_at INTEGER NOT NULL CHECK (captured_at < starts_at),
  projection REAL NOT NULL,
  sample_size INTEGER NOT NULL CHECK (sample_size >= 4),
  actual INTEGER,
  graded_at INTEGER,
  PRIMARY KEY (game_id, player_id, market, model_version)
);

CREATE INDEX IF NOT EXISTS nba_forecasts_history ON nba_forecasts (starts_at DESC);
CREATE INDEX IF NOT EXISTS nba_forecasts_pending ON nba_forecasts (slate_date, actual);
