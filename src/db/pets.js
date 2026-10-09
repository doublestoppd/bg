// All SQL for the pets table.

const PET_COLUMNS = 'id, user_id, name, species, hunger, happiness, health, created_at, updated_at';

export async function findPetsByOwner(db, userId) {
  const { rows } = await db.query(
    `SELECT ${PET_COLUMNS} FROM pets WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return rows;
}

// Looks a pet up by id AND owner, so a player can never reach another
// player's pet by changing the number in the address bar.
export async function findPetForOwner(db, petId, userId) {
  const { rows } = await db.query(
    `SELECT ${PET_COLUMNS} FROM pets WHERE id = $1 AND user_id = $2`,
    [petId, userId],
  );
  return rows[0] || null;
}

export async function countPetsByOwner(db, userId) {
  const { rows } = await db.query('SELECT COUNT(*) AS count FROM pets WHERE user_id = $1', [userId]);
  return rows[0].count;
}

export async function insertPet(db, { userId, name, species, hunger, happiness, health }) {
  const { rows } = await db.query(
    `INSERT INTO pets (user_id, name, species, hunger, happiness, health)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PET_COLUMNS}`,
    [userId, name, species, hunger, happiness, health],
  );
  return rows[0];
}

// Writes new stat values. Filtering by owner as well as id means the
// update does nothing (and returns false) if the pet is not theirs.
export async function updatePetStats(db, petId, userId, { hunger, happiness, health }) {
  const result = await db.query(
    `UPDATE pets SET hunger = $1, happiness = $2, health = $3, updated_at = now()
     WHERE id = $4 AND user_id = $5`,
    [hunger, happiness, health, petId, userId],
  );
  return result.rowCount === 1;
}
