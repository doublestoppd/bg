// All SQL for the shop_purchases table.

const PURCHASE_COLUMNS = 'id, user_id, shop_id, item_id, quantity, unit_price, total_cost, idempotency_key, request_hash, created_at';

export async function insertPurchase(db, { userId, shopId, itemId, quantity, unitPrice, totalCost, idempotencyKey, requestHash }) {
  const { rows } = await db.query(
    `INSERT INTO shop_purchases (user_id, shop_id, item_id, quantity, unit_price, total_cost, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PURCHASE_COLUMNS}`,
    [userId, shopId, itemId, quantity, unitPrice, totalCost, idempotencyKey, requestHash],
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
