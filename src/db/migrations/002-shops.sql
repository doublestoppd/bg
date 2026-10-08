-- Live shop state: schedules, restock history, limited stock, daily caps.
-- Shop definitions and merchandise configuration stay in src/game/shops.js;
-- these tables hold only what changes at runtime.

-- One row per shop in the catalog, created at startup if missing and never
-- reset, so a restart keeps the schedule and the current stock.
CREATE TABLE shop_state (
  shop_id            TEXT PRIMARY KEY,
  paused             BOOLEAN NOT NULL DEFAULT false,   -- no automatic restocks while true
  last_restock_at    TIMESTAMPTZ,
  next_restock_at    TIMESTAMPTZ NOT NULL,
  current_restock_id BIGINT,                           -- FK added below
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every restock that ever happened. superseded_at is set when the next
-- restock replaces this one's listings; rows are never deleted.
CREATE TABLE shop_restock_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id       TEXT    NOT NULL REFERENCES shop_state(shop_id),
  triggered_by  TEXT    NOT NULL,                       -- 'scheduler' or 'admin:<username>'
  listing_count INTEGER NOT NULL DEFAULT 0 CHECK (listing_count >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ
);
CREATE INDEX shop_restock_events_shop ON shop_restock_events (shop_id, id);

ALTER TABLE shop_state
  ADD CONSTRAINT shop_state_current_restock
  FOREIGN KEY (current_restock_id) REFERENCES shop_restock_events(id);

-- A limited listing: one item in one restock at one price. remaining_quantity
-- counts down as players buy; active flips to false when the restock is
-- replaced, and purchases check it under a row lock. Rows are kept forever
-- so purchase history stays explainable.
CREATE TABLE shop_stock (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id            TEXT    NOT NULL REFERENCES shop_state(shop_id),
  restock_id         BIGINT  NOT NULL REFERENCES shop_restock_events(id),
  item_id            TEXT    NOT NULL REFERENCES items(id),
  unit_price         BIGINT  NOT NULL CHECK (unit_price BETWEEN 1 AND 1000000),
  initial_quantity   INTEGER NOT NULL CHECK (initial_quantity > 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity BETWEEN 0 AND initial_quantity),
  max_per_purchase   INTEGER NOT NULL CHECK (max_per_purchase > 0),
  max_per_account    INTEGER NOT NULL CHECK (max_per_account > 0),  -- per restock
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restock_id, item_id)
);
CREATE INDEX shop_stock_active ON shop_stock (shop_id) WHERE active;

-- How many copies of an item restocks have created on each UTC day, for
-- entries with a dailySupplyCap. Counts creation, not ownership.
CREATE TABLE daily_item_supply (
  item_id          TEXT    NOT NULL REFERENCES items(id),
  supply_date      DATE    NOT NULL,
  quantity_created INTEGER NOT NULL DEFAULT 0 CHECK (quantity_created >= 0),
  PRIMARY KEY (item_id, supply_date)
);

-- Purchases of limited stock point at the listing they came from.
-- Essentials purchases leave both NULL.
ALTER TABLE shop_purchases
  ADD COLUMN stock_id   BIGINT REFERENCES shop_stock(id),
  ADD COLUMN restock_id BIGINT REFERENCES shop_restock_events(id);
CREATE INDEX shop_purchases_stock_user ON shop_purchases (stock_id, user_id);
