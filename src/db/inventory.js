// All SQL for the inventory table.

// Everything a player owns, joined with the item definition so the page
// can show names and pictures even for retired items.
export function findInventoryByOwner(db, userId) {
  return db.prepare(`
    SELECT inventory.item_id, inventory.quantity,
           items.name, items.description, items.category, items.rarity,
           items.image, items.effects, items.retired
    FROM inventory
    JOIN items ON items.id = inventory.item_id
    WHERE inventory.user_id = ?
    ORDER BY items.category, items.name
  `).all(userId);
}

export function findStack(db, userId, itemId) {
  return db.prepare('SELECT item_id, quantity FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId) || null;
}

// Adds to a stack, creating it if the player has none of that item.
export function addToStack(db, userId, itemId, quantity) {
  db.prepare(`
    INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?)
    ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
  `).run(userId, itemId, quantity);
}

// Takes from a stack only if it holds enough. Returns true when it did.
// The quantity check is part of each statement, so two requests racing
// for the last item cannot both succeed. Taking everything deletes the
// row (the table forbids a zero quantity); taking less subtracts.
export function removeFromStack(db, userId, itemId, quantity) {
  const deleted = db
    .prepare('DELETE FROM inventory WHERE user_id = ? AND item_id = ? AND quantity = ?')
    .run(userId, itemId, quantity);
  if (deleted.changes === 1) return true;

  const updated = db
    .prepare('UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ? AND quantity > ?')
    .run(quantity, userId, itemId, quantity);
  return updated.changes === 1;
}
