import { Store } from 'express-session';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

// A session store that keeps express-session data in our SQLite database,
// so logins survive server restarts. express-session expects the methods
// get, set, destroy and touch, each reporting back through a callback.
export class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    this.statements = {
      // expires_at is stored as an ISO 8601 string ("2026-01-01T12:00:00.000Z")
      // while datetime('now') produces "2026-01-01 12:00:00". The two formats
      // do not sort together as plain text, so both sides must go through
      // datetime() before comparing.
      get: db.prepare("SELECT data FROM sessions WHERE sid = ? AND datetime(expires_at) > datetime('now')"),
      set: db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      deleteExpired: db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')"),
    };

    // Sweep out expired rows now and then. unref() lets the process exit
    // (for example when tests finish) without waiting on this timer.
    this.cleanupTimer = setInterval(() => this.deleteExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    try {
      const row = this.statements.get.get(sid);
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback) {
    try {
      this.statements.set.run(sid, JSON.stringify(sessionData), expiryFor(sessionData));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.statements.destroy.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback) {
    try {
      this.statements.touch.run(expiryFor(sessionData), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  deleteExpired() {
    this.statements.deleteExpired.run();
  }
}

// Works out when a session should expire from the cookie settings
// express-session attaches to it.
function expiryFor(sessionData) {
  const cookie = sessionData && sessionData.cookie;
  if (cookie && cookie.expires) {
    return new Date(cookie.expires).toISOString();
  }
  const maxAge = cookie && cookie.maxAge ? cookie.maxAge : ONE_DAY_MS;
  return new Date(Date.now() + maxAge).toISOString();
}
