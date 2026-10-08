// All SQL for the shopping_restrictions table.

const COLUMNS = 'id, user_id, reason, created_by, created_at, expires_at, lifted_at, lifted_by';

// The restriction currently in force for an account, if any.
export async function findActiveRestriction(db, userId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM shopping_restrictions
     WHERE user_id = $1 AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

export async function insertRestriction(db, { userId, reason, createdBy, expiresAt = null }) {
  const { rows } = await db.query(
    `INSERT INTO shopping_restrictions (user_id, reason, created_by, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [userId, reason, createdBy, expiresAt],
  );
  return rows[0];
}

// Lifts every restriction in force for the account. Returns how many.
export async function liftRestrictions(db, userId, liftedBy) {
  const result = await db.query(
    `UPDATE shopping_restrictions SET lifted_at = now(), lifted_by = $2
     WHERE user_id = $1 AND lifted_at IS NULL`,
    [userId, liftedBy],
  );
  return result.rowCount;
}

export async function findRestrictionsByUser(db, userId) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM shopping_restrictions WHERE user_id = $1 ORDER BY id`, [userId]);
  return rows;
}
