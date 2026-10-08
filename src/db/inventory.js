// All SQL for the inventory table.

// Everything a player owns, joined with the item definition so the page
// can show names and pictures even for retired items.
export async function findInventoryByOwner(db, userId) {
  const { rows } = await db.query(
    `SELECT inventory.item_id, inventory.quantity,
            items.name, items.description, items.category, items.rarity,
            items.image, items.effects, items.retired, items.obtainable
     FROM inventory
     JOIN items ON items.id = inventory.item_id
     WHERE inventory.user_id = $1
     ORDER BY items.category, items.name`,
    [userId],
  );
  return rows;
}

export async function findStack(db, userId, itemId) {
  const { rows } = await db.query(
    'SELECT item_id, quantity FROM inventory WHERE user_id = $1 AND item_id = $2',
    [userId, itemId],
  );
  return rows[0] || null;
}

// Adds to a stack, creating it if the player has none of that item.
// Returns false, changing nothing, if the stack would grow past maxStack.
// The limit is checked inside the statement so concurrent grants cannot
// combine to exceed it.
export async function addToStack(db, userId, itemId, quantity, maxStack) {
  const result = await db.query(
    `INSERT INTO inventory (user_id, item_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventory.quantity + excluded.quantity
       WHERE inventory.quantity + excluded.quantity <= $4`,
    [userId, itemId, quantity, maxStack],
  );
  return result.rowCount === 1;
}

// Takes from a stack only if it holds enough. Returns true when it did.
// The quantity check is part of each statement, so two requests racing
// for the last item cannot both succeed. Taking everything deletes the
// row (the table forbids a zero quantity); taking less subtracts.
export async function removeFromStack(db, userId, itemId, quantity) {
  const deleted = await db.query(
    'DELETE FROM inventory WHERE user_id = $1 AND item_id = $2 AND quantity = $3',
    [userId, itemId, quantity],
  );
  if (deleted.rowCount === 1) return true;

  const updated = await db.query(
    'UPDATE inventory SET quantity = quantity - $3 WHERE user_id = $1 AND item_id = $2 AND quantity > $3',
    [userId, itemId, quantity],
  );
  return updated.rowCount === 1;
}
