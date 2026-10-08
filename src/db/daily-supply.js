// All SQL for the daily_item_supply table.

// Reserves up to `wanted` copies of an item against its daily cap and
// returns how many were allowed (possibly 0). The row is locked while the
// decision is made, so two restocks running at once cannot both squeeze
// under the cap. Must run inside a transaction.
export async function reserveDailySupply(db, itemId, supplyDate, wanted, cap) {
  await db.query(
    'INSERT INTO daily_item_supply (item_id, supply_date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [itemId, supplyDate],
  );
  const { rows } = await db.query(
    'SELECT quantity_created FROM daily_item_supply WHERE item_id = $1 AND supply_date = $2 FOR UPDATE',
    [itemId, supplyDate],
  );
  const allowed = Math.max(0, Math.min(wanted, cap - rows[0].quantity_created));
  if (allowed > 0) {
    await db.query(
      'UPDATE daily_item_supply SET quantity_created = quantity_created + $3 WHERE item_id = $1 AND supply_date = $2',
      [itemId, supplyDate, allowed],
    );
  }
  return allowed;
}

export async function findDailySupply(db, itemId, supplyDate) {
  const { rows } = await db.query(
    'SELECT quantity_created FROM daily_item_supply WHERE item_id = $1 AND supply_date = $2',
    [itemId, supplyDate],
  );
  return rows.length ? rows[0].quantity_created : 0;
}
