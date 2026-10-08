// All SQL for the coin_transactions table (the coin ledger).

export function insertCoinTransaction(db, { userId, amount, balanceAfter, reason, shopId, itemId, quantity }) {
  db.prepare(`
    INSERT INTO coin_transactions (user_id, amount, balance_after, reason, shop_id, item_id, quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, amount, balanceAfter, reason, shopId, itemId, quantity);
}

export function findCoinTransactionsByUser(db, userId) {
  return db.prepare('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY id').all(userId);
}
