// All SQL for the shop_state table.

const STATE_COLUMNS = 'shop_id, paused, last_restock_at, next_restock_at, current_restock_id, updated_at';

// Creates the row for a shop if it does not exist, due immediately.
// Existing rows are left alone so a restart never resets a schedule.
export async function ensureShopState(db, shopId, nextRestockAt) {
  await db.query(
    `INSERT INTO shop_state (shop_id, next_restock_at) VALUES ($1, $2) ON CONFLICT (shop_id) DO NOTHING`,
    [shopId, nextRestockAt],
  );
}

export async function findShopState(db, shopId) {
  const { rows } = await db.query(`SELECT ${STATE_COLUMNS} FROM shop_state WHERE shop_id = $1`, [shopId]);
  return rows[0] || null;
}

export async function allShopStates(db) {
  const { rows } = await db.query(`SELECT ${STATE_COLUMNS} FROM shop_state ORDER BY shop_id`);
  return rows;
}

// Locks a shop's row for the rest of the transaction. SKIP LOCKED means a
// second worker that arrives while the first holds the lock gets null
// straight away instead of waiting, so it simply moves on.
export async function lockShopStateSkipLocked(db, shopId) {
  const { rows } = await db.query(
    `SELECT ${STATE_COLUMNS} FROM shop_state WHERE shop_id = $1 FOR UPDATE SKIP LOCKED`,
    [shopId],
  );
  return rows[0] || null;
}

export async function recordRestock(db, shopId, { restockedAt, nextRestockAt, restockId }) {
  await db.query(
    `UPDATE shop_state
     SET last_restock_at = $2, next_restock_at = $3, current_restock_id = $4, updated_at = now()
     WHERE shop_id = $1`,
    [shopId, restockedAt, nextRestockAt, restockId],
  );
}

export async function setShopPaused(db, shopId, paused) {
  const result = await db.query(
    'UPDATE shop_state SET paused = $2, updated_at = now() WHERE shop_id = $1',
    [shopId, paused],
  );
  return result.rowCount;
}
