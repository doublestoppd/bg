// All SQL for the users table.

export function findUserById(db, id) {
  return db.prepare('SELECT id, username, coins, created_at FROM users WHERE id = ?').get(id) || null;
}

// Includes the password hash; only the login code should need this.
export function findUserByUsernameWithPassword(db, username) {
  return db.prepare('SELECT id, username, password_hash, coins FROM users WHERE username = ?').get(username) || null;
}

export function usernameExists(db, username) {
  return db.prepare('SELECT 1 FROM users WHERE username = ?').get(username) !== undefined;
}

export function insertUser(db, { username, passwordHash, coins }) {
  const result = db
    .prepare('INSERT INTO users (username, password_hash, coins) VALUES (?, ?, ?)')
    .run(username, passwordHash, coins);
  return findUserById(db, result.lastInsertRowid);
}

export function findCoins(db, userId) {
  const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
  return row ? row.coins : null;
}

// Subtracts only if the balance covers it. Returns the number of rows
// changed: 1 on success, 0 if the player could not afford it.
export function subtractCoins(db, userId, amount) {
  return db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?').run(amount, userId, amount).changes;
}

// Adds only if the result stays within maxCoins. Returns rows changed.
export function addCoins(db, userId, amount, maxCoins) {
  return db.prepare('UPDATE users SET coins = coins + ? WHERE id = ? AND coins + ? <= ?').run(amount, userId, amount, maxCoins).changes;
}
