// All SQL for the shop_purchases table.

const PURCHASE_COLUMNS = 'id, user_id, shop_id, item_id, quantity, unit_price, total_cost, idempotency_key, request_hash, stock_id, restock_id, created_at';

export async function insertPurchase(db, { userId, shopId, itemId, quantity, unitPrice, totalCost, idempotencyKey, requestHash, stockId = null, restockId = null }) {
  const { rows } = await db.query(
    `INSERT INTO shop_purchases (user_id, shop_id, item_id, quantity, unit_price, total_cost, idempotency_key, request_hash, stock_id, restock_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${PURCHASE_COLUMNS}`,
    [userId, shopId, itemId, quantity, unitPrice, totalCost, idempotencyKey, requestHash, stockId, restockId],
  );
  return rows[0];
}

export async function findPurchaseByKey(db, userId, idempotencyKey) {
  const { rows } = await db.query(
    `SELECT ${PURCHASE_COLUMNS} FROM shop_purchases WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  return rows[0] || null;
}

export async function findPurchasesByUser(db, userId) {
  const { rows } = await db.query(
    `SELECT ${PURCHASE_COLUMNS} FROM shop_purchases WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return rows;
}

// How many copies this account has already bought from one listing.
export async function sumPurchasedFromListing(db, userId, stockId) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(quantity), 0)::int AS total FROM shop_purchases WHERE user_id = $1 AND stock_id = $2',
    [userId, stockId],
  );
  return rows[0].total;
}
