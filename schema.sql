CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  label TEXT,
  reason TEXT,
  note TEXT,
  color TEXT,
  mode TEXT,
  created_at INTEGER,
  expires_at INTEGER,
  active INTEGER DEFAULT 1,
  revoked INTEGER DEFAULT 0,
  completed INTEGER DEFAULT 0,
  sharing INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id TEXT,
  lat REAL,
  lng REAL,
  accuracy REAL,
  at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_loc_req ON locations(req_id, at);
