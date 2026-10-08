import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/connection.js';
import { SqliteSessionStore } from '../../src/db/sessions.js';

// express-session's store methods report back through callbacks; these
// wrappers turn them into promises so the tests read top to bottom.
function storeFor(db) {
  const store = new SqliteSessionStore(db);
  return {
    get: (sid) => new Promise((resolve, reject) => store.get(sid, (e, v) => (e ? reject(e) : resolve(v)))),
    set: (sid, data) => new Promise((resolve, reject) => store.set(sid, data, (e) => (e ? reject(e) : resolve()))),
    touch: (sid, data) => new Promise((resolve, reject) => store.touch(sid, data, (e) => (e ? reject(e) : resolve()))),
    destroy: (sid) => new Promise((resolve, reject) => store.destroy(sid, (e) => (e ? reject(e) : resolve()))),
    deleteExpired: () => store.deleteExpired(),
  };
}

function sessionExpiringIn(milliseconds) {
  return { cookie: { expires: new Date(Date.now() + milliseconds).toISOString() }, userId: 7 };
}

test('a live session can be read back', async () => {
  const store = storeFor(openDatabase(':memory:'));
  await store.set('abc', sessionExpiringIn(60_000));
  const session = await store.get('abc');
  assert.equal(session.userId, 7);
});

test('a session that expired moments ago is not returned', async () => {
  // Regression test: expires_at is ISO 8601 and the comparison once used
  // plain string ordering, which treated anything expiring later the same
  // day as still valid.
  const store = storeFor(openDatabase(':memory:'));
  await store.set('abc', sessionExpiringIn(-1_000));
  assert.equal(await store.get('abc'), null);
});

test('deleteExpired removes only expired rows', async () => {
  const db = openDatabase(':memory:');
  const store = storeFor(db);
  await store.set('old', sessionExpiringIn(-1_000));
  await store.set('fresh', sessionExpiringIn(60_000));
  store.deleteExpired();
  const remaining = db.prepare('SELECT sid FROM sessions ORDER BY sid').all().map((row) => row.sid);
  assert.deepEqual(remaining, ['fresh']);
});

test('touch extends a session and destroy removes it', async () => {
  const store = storeFor(openDatabase(':memory:'));
  await store.set('abc', sessionExpiringIn(60_000));
  await store.touch('abc', sessionExpiringIn(-1_000));
  assert.equal(await store.get('abc'), null, 'touch moved the expiry into the past');

  await store.set('abc', sessionExpiringIn(60_000));
  await store.destroy('abc');
  assert.equal(await store.get('abc'), null);
});
