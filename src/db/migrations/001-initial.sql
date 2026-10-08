-- Blobgarden initial schema (PostgreSQL).
-- Migrations are applied once, in filename order, by src/db/migrate.js.
-- Never edit an applied migration; add a new numbered file instead.
-- All timestamps are TIMESTAMPTZ and the server works in UTC.

-- Player accounts. Usernames are unique ignoring case (see the index).
-- coins is the player's whole purse; src/game/currency.js is the only
-- code that changes it, and the CHECK matches MAX_COINS there.
CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  coins         BIGINT  NOT NULL DEFAULT 0 CHECK (coins BETWEEN 0 AND 1000000000),
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

-- Login sessions, managed by src/db/sessions.js for express-session.
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE pets (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT   NOT NULL REFERENCES users(id),
  name       TEXT     NOT NULL,
  species    TEXT     NOT NULL,
  hunger     SMALLINT NOT NULL CHECK (hunger BETWEEN 0 AND 100),     -- 0 starving, 100 full
  happiness  SMALLINT NOT NULL CHECK (happiness BETWEEN 0 AND 100),
  health     SMALLINT NOT NULL CHECK (health BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pets_user_id ON pets (user_id);

-- A copy of the item catalog from src/game/items.js, kept in sync at
-- startup so inventory rows can reference items with a foreign key. The
-- JavaScript catalog is the source of truth; rows are never deleted. An
-- item dropped from the catalog is marked retired (kept, unusable); one
-- with obtainable = false is still usable but no longer handed out.
CREATE TABLE items (
  id          TEXT    PRIMARY KEY,          -- stable slug, never reused
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  rarity      TEXT    NOT NULL,
  image       TEXT,                         -- URL path, NULL until artwork exists
  effects     JSONB   NOT NULL,             -- e.g. {"hunger": 25}
  obtainable  BOOLEAN NOT NULL DEFAULT true,
  retired     BOOLEAN NOT NULL DEFAULT false,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per player per item type; quantity is the stack size. The range
-- matches MAX_STACK_SIZE in src/game/inventory.js. Emptying a stack
-- deletes the row.
CREATE TABLE inventory (
  user_id  BIGINT  NOT NULL REFERENCES users(id),
  item_id  TEXT    NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  PRIMARY KEY (user_id, item_id)
);

-- Completed shop purchases. idempotency_key is the random request id
-- printed into the buy form; the unique constraint means a resubmitted
-- form can never buy twice. request_hash ties the key to what was bought
-- so it cannot be reused to authorise a different purchase.
CREATE TABLE shop_purchases (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT  NOT NULL REFERENCES users(id),
  shop_id         TEXT    NOT NULL,
  item_id         TEXT    NOT NULL REFERENCES items(id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_price      BIGINT  NOT NULL CHECK (unit_price > 0),
  total_cost      BIGINT  NOT NULL CHECK (total_cost > 0),
  idempotency_key TEXT    NOT NULL,
  request_hash    TEXT    NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX shop_purchases_user_created ON shop_purchases (user_id, created_at);

-- The coin ledger. Every change to a purse is recorded here by
-- src/game/currency.js: amount is negative for spending, positive for
-- income, and the ledger always sums to the balance.
CREATE TABLE coin_transactions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT  NOT NULL REFERENCES users(id),
  amount        BIGINT  NOT NULL CHECK (amount <> 0),
  balance_after BIGINT  NOT NULL CHECK (balance_after >= 0),
  reason        TEXT    NOT NULL,            -- 'welcome', 'purchase', later 'reward' ...
  shop_id       TEXT,
  item_id       TEXT    REFERENCES items(id),
  quantity      INTEGER CHECK (quantity IS NULL OR quantity > 0),
  purchase_id   BIGINT  REFERENCES shop_purchases(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coin_transactions_user_id ON coin_transactions (user_id, id);

-- Fixed-window request counters for rate limiting (src/middleware/rate-limit.js).
-- scope names the limit ('login:ip'), key identifies who ('203.0.113.5'),
-- window_start is the start of the current window. Old rows are pruned.
CREATE TABLE request_counters (
  scope        TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window_start)
);
CREATE INDEX request_counters_window ON request_counters (window_start);
