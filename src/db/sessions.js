import { Store } from 'express-session';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// A session store that keeps express-session data in PostgreSQL, so logins
// survive server restarts and are shared between server processes.
// express-session expects get, set, destroy and touch, each reporting back
// through a callback; the async methods below are wrapped accordingly.
export class PgSessionStore extends Store {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  get(sid, callback) {
    this.pool
      .query('SELECT data FROM sessions WHERE sid = $1 AND expires_at > now()', [sid])
      .then(({ rows }) => callback(null, rows.length ? rows[0].data : null))
      .catch(callback);
  }

  set(sid, sessionData, callback) {
    this.pool
      .query(
        `INSERT INTO sessions (sid, data, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        [sid, sessionData, expiryFor(sessionData)],
      )
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    this.pool
      .query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sessionData, callback) {
    this.pool
      .query('UPDATE sessions SET expires_at = $1 WHERE sid = $2', [expiryFor(sessionData), sid])
      .then(() => callback(null))
      .catch(callback);
  }
}

// Removes sessions past their expiry; the scheduler calls this now and then.
export async function deleteExpiredSessions(db) {
  const result = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount;
}

// Works out when a session should expire from the cookie settings
// express-session attaches to it.
function expiryFor(sessionData) {
  const cookie = sessionData && sessionData.cookie;
  if (cookie && cookie.expires) {
    return new Date(cookie.expires);
  }
  const maxAge = cookie && cookie.maxAge ? cookie.maxAge : ONE_DAY_MS;
  return new Date(Date.now() + maxAge);
}
