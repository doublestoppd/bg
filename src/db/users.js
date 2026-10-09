// All SQL for the users table.

const USER_COLUMNS = 'id, username, coins, is_admin, created_at';

export async function findUserById(db, id) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Usernames are matched ignoring case, like the unique index.
export async function findUserByUsername(db, username) {
  return findByUsername(db, username, USER_COLUMNS);
}

// The same row with the password hash; only the login code should need it.
export async function findUserByUsernameWithPassword(db, username) {
  return findByUsername(db, username, `${USER_COLUMNS}, password_hash`);
}

async function findByUsername(db, username, columns) {
  const { rows } = await db.query(`SELECT ${columns} FROM users WHERE lower(username) = lower($1)`, [username]);
  return rows[0] || null;
}

export async function usernameExists(db, username) {
  const { rows } = await db.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  return rows.length > 0;
}

export async function insertUser(db, { username, passwordHash, coins }) {
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, coins) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
    [username, passwordHash, coins],
  );
  return rows[0];
}

// Locks the player's row for the rest of the current transaction, so two
// purchases by the same account run one after the other. Must be called
// inside a transaction; returns the row or null.
export async function lockUser(db, userId) {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  return rows[0] || null;
}

export async function findCoins(db, userId) {
  const { rows } = await db.query('SELECT coins FROM users WHERE id = $1', [userId]);
  return rows.length ? rows[0].coins : null;
}

// Subtracts only if the balance covers it. Returns true when it did, false
// if the player could not afford it.
export async function subtractCoins(db, userId, amount) {
  const result = await db.query(
    'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1',
    [amount, userId],
  );
  return result.rowCount === 1;
}

// Adds only if the result stays within maxCoins. Returns true when it did.
export async function addCoins(db, userId, amount, maxCoins) {
  const result = await db.query(
    'UPDATE users SET coins = coins + $1 WHERE id = $2 AND coins + $1 <= $3',
    [amount, userId, maxCoins],
  );
  return result.rowCount === 1;
}
