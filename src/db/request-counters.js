// All SQL for the request_counters table (rate limiting).

// Adds one to the counter for this scope, key and window and returns the
// new count. The upsert makes it safe under concurrent requests and across
// several server processes.
export async function incrementCounter(db, scope, key, windowStart) {
  const { rows } = await db.query(
    `INSERT INTO request_counters (scope, key, window_start, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope, key, window_start) DO UPDATE SET count = request_counters.count + 1
     RETURNING count`,
    [scope, key, windowStart],
  );
  return rows[0].count;
}

export async function deleteCountersBefore(db, time) {
  const result = await db.query('DELETE FROM request_counters WHERE window_start < $1', [time]);
  return result.rowCount;
}

// The current count without adding to it (0 if there is no row).
export async function readCounter(db, scope, key, windowStart) {
  const { rows } = await db.query(
    'SELECT count FROM request_counters WHERE scope = $1 AND key = $2 AND window_start = $3',
    [scope, key, windowStart],
  );
  return rows.length ? rows[0].count : 0;
}
