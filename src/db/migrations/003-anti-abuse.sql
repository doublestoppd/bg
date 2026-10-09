-- Durable anti-abuse records: reviewable restrictions and an activity log.
-- Rate-limit counters already live in request_counters (migration 001),
-- and per-account purchase limits are counted from shop_purchases.

-- A shopping restriction stops an account buying limited stock (essentials
-- stay available so pets can still be fed). Imposed and lifted by an
-- administrator through the shop-admin utility, always with a reason, so
-- every restriction can be reviewed.
CREATE TABLE shopping_restrictions (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  reason     TEXT   NOT NULL,
  created_by TEXT   NOT NULL,            -- 'admin:<username>'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                -- NULL = until lifted
  lifted_at  TIMESTAMPTZ,
  lifted_by  TEXT
);
CREATE INDEX shopping_restrictions_active ON shopping_restrictions (user_id) WHERE lifted_at IS NULL;

-- Things worth looking at later: refused purchases and why, rate-limit
-- hits, administrator actions. Rows older than the retention period
-- (ACTIVITY_LOG_RETENTION_DAYS in src/game/shop-limits.js) are deleted by
-- the scheduler. Only the account id, the client IP and the shop details
-- are kept; nothing else about the visitor.
CREATE TABLE shop_activity_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id),
  ip         TEXT,
  kind       TEXT   NOT NULL,            -- e.g. 'sold_out', 'expired_listing', 'rate_limited', 'admin_pause'
  shop_id    TEXT,
  stock_id   BIGINT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shop_activity_log_user_time ON shop_activity_log (user_id, created_at);
CREATE INDEX shop_activity_log_time ON shop_activity_log (created_at);
