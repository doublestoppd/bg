// All SQL for the items table (the synchronised copy of the catalog).

export async function upsertItem(db, { id, name, description, category, image, effects, obtainable }) {
  await db.query(
    `INSERT INTO items (id, name, description, category, image, effects, obtainable, retired)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       category = excluded.category,
       image = excluded.image,
       effects = excluded.effects,
       obtainable = excluded.obtainable,
       retired = false`,
    [id, name, description, category, image, effects, obtainable],
  );
}

// Marks every item not in the given list as retired. Nothing is deleted.
export async function retireItemsNotIn(db, liveIds) {
  await db.query('UPDATE items SET retired = true WHERE id <> ALL($1::text[])', [liveIds]);
}

export async function findItemRow(db, id) {
  const { rows } = await db.query('SELECT * FROM items WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function allItemRows(db) {
  const { rows } = await db.query('SELECT * FROM items ORDER BY id');
  return rows;
}
