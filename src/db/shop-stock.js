// All SQL for the shop_stock table (limited listings).

const STOCK_COLUMNS = `shop_stock.id, shop_stock.shop_id, shop_stock.restock_id, shop_stock.item_id,
  shop_stock.unit_price, shop_stock.initial_quantity, shop_stock.remaining_quantity,
  shop_stock.max_per_purchase, shop_stock.max_per_account, shop_stock.active, shop_stock.created_at`;

export async function insertListing(db, { shopId, restockId, itemId, unitPrice, quantity, maxPerPurchase, maxPerAccount }) {
  const { rows } = await db.query(
    `INSERT INTO shop_stock (shop_id, restock_id, item_id, unit_price, initial_quantity, remaining_quantity, max_per_purchase, max_per_account)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING ${STOCK_COLUMNS}`,
    [shopId, restockId, itemId, unitPrice, quantity, maxPerPurchase, maxPerAccount],
  );
  return rows[0];
}

// Retires every current listing of a shop. This takes a row lock on each
// one, so it waits for any purchase that is mid-flight on that listing.
export async function deactivateListings(db, shopId) {
  const result = await db.query('UPDATE shop_stock SET active = false WHERE shop_id = $1 AND active', [shopId]);
  return result.rowCount;
}

// Current listings with the item definition attached, sold-out ones included.
export async function findActiveListings(db, shopId) {
  const { rows } = await db.query(
    `SELECT ${STOCK_COLUMNS}, items.name, items.description, items.rarity, items.category, items.image
     FROM shop_stock JOIN items ON items.id = shop_stock.item_id
     WHERE shop_stock.shop_id = $1 AND shop_stock.active
     ORDER BY items.rarity DESC, items.name`,
    [shopId],
  );
  return rows;
}

export async function findListingsByRestock(db, restockId) {
  const { rows } = await db.query(
    `SELECT ${STOCK_COLUMNS} FROM shop_stock WHERE restock_id = $1 ORDER BY id`,
    [restockId],
  );
  return rows;
}

// Locks one listing for the rest of the transaction and returns it (or
// null). Purchases of the same listing therefore run one at a time, and a
// restock that wants to retire the listing waits for them.
export async function lockListing(db, stockId) {
  const { rows } = await db.query(`SELECT ${STOCK_COLUMNS} FROM shop_stock WHERE shop_stock.id = $1 FOR UPDATE`, [stockId]);
  return rows[0] || null;
}

// Takes copies off the shelf only if the listing is still active and has
// enough. Returns rows changed (1 or 0), so the caller can tell.
export async function decrementListing(db, stockId, quantity) {
  const result = await db.query(
    `UPDATE shop_stock SET remaining_quantity = remaining_quantity - $2
     WHERE id = $1 AND active AND remaining_quantity >= $2`,
    [stockId, quantity],
  );
  return result.rowCount;
}
