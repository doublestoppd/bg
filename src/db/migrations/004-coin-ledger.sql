-- The coin ledger, and hard limits on coin balances.

-- Every change to a player's coins is recorded here by src/game/currency.js.
-- amount is signed: negative for spending, positive for income. The
-- shop/item/quantity columns are filled in for purchases and NULL for
-- everything else (welcome purse, future rewards).
CREATE TABLE coin_transactions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  amount        INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount != 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason        TEXT    NOT NULL,
  shop_id       TEXT,
  item_id       TEXT    REFERENCES items(id),
  quantity      INTEGER CHECK (quantity IS NULL OR quantity > 0),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX coin_transactions_user_id ON coin_transactions(user_id, id);

-- Balances get a floor of 0 and a ceiling matching MAX_COINS in
-- src/game/currency.js. SQLite cannot add a CHECK to an existing table, so
-- users is rebuilt and its rows copied, the same way migration 003 rebuilt
-- inventory. The migration runner keeps foreign keys off while this runs
-- and verifies them before committing, so the tables that reference users
-- (pets, inventory, coin_transactions) come through intact.
CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  coins         INTEGER NOT NULL DEFAULT 0
                        CHECK (typeof(coins) = 'integer' AND coins BETWEEN 0 AND 1000000000),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users_new (id, username, password_hash, coins, created_at)
  SELECT id, username, password_hash, coins, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
