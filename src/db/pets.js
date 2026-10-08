// All SQL for the pets table.

const PET_COLUMNS = 'id, user_id, name, species, hunger, happiness, health, created_at, updated_at';

export function findPetsByOwner(db, userId) {
  return db.prepare(`SELECT ${PET_COLUMNS} FROM pets WHERE user_id = ? ORDER BY created_at, id`).all(userId);
}

// Looks a pet up by id AND owner, so a player can never reach another
// player's pet by changing the number in the address bar.
export function findPetForOwner(db, petId, userId) {
  return db.prepare(`SELECT ${PET_COLUMNS} FROM pets WHERE id = ? AND user_id = ?`).get(petId, userId) || null;
}

export function countPetsByOwner(db, userId) {
  return db.prepare('SELECT COUNT(*) AS count FROM pets WHERE user_id = ?').get(userId).count;
}

export function insertPet(db, { userId, name, species, hunger, happiness, health }) {
  const result = db
    .prepare('INSERT INTO pets (user_id, name, species, hunger, happiness, health) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, name, species, hunger, happiness, health);
  return findPetForOwner(db, result.lastInsertRowid, userId);
}

// Writes new stat values. Filtering by owner as well as id means the
// update silently does nothing (changes = 0) if the pet is not theirs.
export function updatePetStats(db, petId, userId, { hunger, happiness, health }) {
  const result = db.prepare(`
    UPDATE pets SET hunger = ?, happiness = ?, health = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(hunger, happiness, health, petId, userId);
  return result.changes;
}
