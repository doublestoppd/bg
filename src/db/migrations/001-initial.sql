-- Initial schema: player accounts and their pets.
-- Migrations are applied once, in filename order. Never edit an applied
-- migration; add a new numbered file instead.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  coins         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT    NOT NULL,
  species    TEXT    NOT NULL,
  hunger     INTEGER NOT NULL,   -- 0 = starving, 100 = full
  happiness  INTEGER NOT NULL,   -- 0 = miserable, 100 = delighted
  health     INTEGER NOT NULL,   -- 0 = very sick, 100 = perfect
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX pets_user_id ON pets(user_id);

-- Login sessions, managed by src/db/sessions.js.
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,      -- JSON written by express-session
  expires_at TEXT NOT NULL       -- ISO 8601 timestamp
);
