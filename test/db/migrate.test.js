import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';

test('migrations create the tables and are not applied twice', () => {
  const db = openDatabase(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['pets', 'schema_migrations', 'sessions', 'users']);

  const before = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  runMigrations(db); // running again must be a no-op
  const after = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(before, after);
  db.close();
});
