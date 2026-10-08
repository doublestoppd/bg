// All SQL for the shop_activity_log table.

export async function insertActivity(db, { userId = null, ip = null, kind, shopId = null, stockId = null, details = null }) {
  await db.query(
    `INSERT INTO shop_activity_log (user_id, ip, kind, shop_id, stock_id, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, ip, kind, shopId, stockId, details],
  );
}

export async function findActivityByUser(db, userId, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, user_id, ip, kind, shop_id, stock_id, details, created_at
     FROM shop_activity_log WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// Accounts with the most logged events since a point in time, with a
// breakdown by kind, for an administrator to look at.
export async function findBusiestAccounts(db, since, limit = 20) {
  const { rows } = await db.query(
    `SELECT shop_activity_log.user_id, users.username, COUNT(*)::int AS events,
            jsonb_object_agg(kind, kind_count) AS by_kind
     FROM (
       SELECT user_id, kind, COUNT(*)::int AS kind_count
       FROM shop_activity_log WHERE created_at >= $1 AND user_id IS NOT NULL
       GROUP BY user_id, kind
     ) AS shop_activity_log
     JOIN users ON users.id = shop_activity_log.user_id
     GROUP BY shop_activity_log.user_id, users.username
     ORDER BY SUM(kind_count) DESC LIMIT $2`,
    [since, limit],
  );
  return rows;
}

export async function deleteActivityBefore(db, time) {
  const result = await db.query('DELETE FROM shop_activity_log WHERE created_at < $1', [time]);
  return result.rowCount;
}
