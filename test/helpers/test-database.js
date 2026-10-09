import { after } from 'node:test';
import config from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { syncItemCatalog } from '../../src/game/items.js';
import { registerAccount } from '../../src/game/accounts.js';

// The test suite runs against a real PostgreSQL database named by
// TEST_DATABASE_URL. It is migrated once per test process and wiped
// before every test, so tests never see each other's rows. Test files run
// one at a time (see the npm test script) because they share this database.

if (!config.testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at a throwaway database.');
}
if (config.testDatabaseUrl === config.databaseUrl) {
  throw new Error('TEST_DATABASE_URL must be a different database from DATABASE_URL: tests wipe it.');
}

let pool = null;
let migrated = false;

export function getTestPool() {
  if (!pool) {
    pool = createPool(config.testDatabaseUrl);
    after(async () => {
      await pool.end();
      pool = null;
    });
  }
  return pool;
}

// A wiped database plus one registered player, the start of most tests.
export async function databaseWithPlayer(username = 'wobble') {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username, password: 'correct horse' });
  return { db, user };
}

// Returns a pool pointing at an empty, freshly migrated database with the
// item catalog loaded. Call at the start of every test.
export async function resetDatabase() {
  const db = getTestPool();
  if (!migrated) {
    await runMigrations(db);
    migrated = true;
  }
  const { rows } = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
  await db.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  await syncItemCatalog(db);
  return db;
}
