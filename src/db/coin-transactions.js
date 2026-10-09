// All SQL for the coin_transactions table (the coin ledger).

export async function insertCoinTransaction(db, { userId, amount, balanceAfter, reason, shopId, itemId, quantity, purchaseId }) {
  await db.query(
    `INSERT INTO coin_transactions (user_id, amount, balance_after, reason, shop_id, item_id, quantity, purchase_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, amount, balanceAfter, reason, shopId, itemId, quantity, purchaseId],
  );
}

export async function findCoinTransactionsByUser(db, userId) {
  const { rows } = await db.query('SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY id', [userId]);
  return rows;
}
