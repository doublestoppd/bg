-- Two refinements to items and inventories.

-- 1. Items can stop being handed out without stopping being usable.
--    obtainable = 0 means no shop, gift or reward may grant the item any
--    more, but players who have one can still use it. This is separate
--    from retired = 1, which means the item has left the catalog entirely
--    and can only be kept.
ALTER TABLE items ADD COLUMN obtainable INTEGER NOT NULL DEFAULT 1;

-- 2. Stack sizes get a hard ceiling. SQLite cannot add a CHECK to an
--    existing table, so the inventory table is rebuilt with the stricter
--    rule and its rows copied across. The ceiling matches MAX_STACK_SIZE
--    in src/game/inventory.js; raising one means raising the other.
CREATE TABLE inventory_new (
  user_id  INTEGER NOT NULL REFERENCES users(id),
  item_id  TEXT    NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 999),
  PRIMARY KEY (user_id, item_id)
);
INSERT INTO inventory_new (user_id, item_id, quantity)
  SELECT user_id, item_id, quantity FROM inventory;
DROP TABLE inventory;
ALTER TABLE inventory_new RENAME TO inventory;
