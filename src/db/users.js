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
