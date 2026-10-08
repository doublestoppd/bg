// All SQL for the shop_restock_events table (restock history).

export async function insertRestockEvent(db, { shopId, triggeredBy, createdAt }) {
  const { rows } = await db.query(
    `INSERT INTO shop_restock_events (shop_id, triggered_by, created_at) VALUES ($1, $2, $3)
     RETURNING id, shop_id, triggered_by, listing_count, created_at, superseded_at`,
    [shopId, triggeredBy, createdAt],
  );
  return rows[0];
}

export async function setRestockListingCount(db, restockId, listingCount) {
  await db.query('UPDATE shop_restock_events SET listing_count = $2 WHERE id = $1', [restockId, listingCount]);
}

// Marks every still-current restock of the shop as replaced.
export async function supersedeRestocks(db, shopId, supersededAt) {
  await db.query(
    'UPDATE shop_restock_events SET superseded_at = $2 WHERE shop_id = $1 AND superseded_at IS NULL',
    [shopId, supersededAt],
  );
}

export async function findRestockEvents(db, shopId, limit = 20) {
  const { rows } = await db.query(
    `SELECT id, shop_id, triggered_by, listing_count, created_at, superseded_at
     FROM shop_restock_events WHERE shop_id = $1 ORDER BY id DESC LIMIT $2`,
    [shopId, limit],
  );
  return rows;
}
