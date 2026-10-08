-- Item definitions and player inventories.

-- A copy of the item catalog from src/game/items.js, kept in sync at
-- startup so that inventory rows can reference items with a foreign key.
-- The JavaScript catalog is the source of truth; this table is never
-- edited by hand. Rows are never deleted: an item removed from the catalog
-- is marked retired so that players who own it keep it.
CREATE TABLE items (
  id          TEXT    PRIMARY KEY,          -- stable slug, never reused
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  rarity      TEXT    NOT NULL,
  image       TEXT,                         -- URL path, NULL until artwork exists
  effects     TEXT    NOT NULL,             -- JSON object, e.g. {"hunger":25}
  retired     INTEGER NOT NULL DEFAULT 0,   -- 1 once dropped from the catalog
  released_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per player per item type; the quantity is the stack size.
-- A stack can never be zero or negative: emptying it deletes the row.
CREATE TABLE inventory (
  user_id  INTEGER NOT NULL REFERENCES users(id),
  item_id  TEXT    NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (user_id, item_id)
);
