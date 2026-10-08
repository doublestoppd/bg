// All SQL for the items table (the synchronised copy of the catalog).

export function upsertItem(db, { id, name, description, category, rarity, image, effects, obtainable }) {
  db.prepare(`
    INSERT INTO items (id, name, description, category, rarity, image, effects, obtainable, retired)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      rarity = excluded.rarity,
      image = excluded.image,
      effects = excluded.effects,
      obtainable = excluded.obtainable,
      retired = 0
  `).run(id, name, description, category, rarity, image, effects, obtainable ? 1 : 0);
}

// Marks every item not in the given list as retired. Nothing is deleted.
export function retireItemsNotIn(db, liveIds) {
  const placeholders = liveIds.map(() => '?').join(', ');
  db.prepare(`UPDATE items SET retired = 1 WHERE id NOT IN (${placeholders})`).run(...liveIds);
}

export function findItemRow(db, id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) || null;
}

export function allItemRows(db) {
  return db.prepare('SELECT * FROM items ORDER BY id').all();
}
