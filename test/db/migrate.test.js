import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from '../helpers/test-database.js';
import { runMigrations } from '../../src/db/migrate.js';

test('migrations create the tables and are not applied twice', async () => {
  const db = await resetDatabase();
  const { rows } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  assert.deepEqual(rows.map((r) => r.tablename), [
    'coin_transactions', 'daily_item_supply', 'inventory', 'items', 'pets', 'request_counters', 'schema_migrations', 'sessions',
    'shop_activity_log', 'shop_purchases', 'shop_restock_events', 'shop_state', 'shop_stock', 'shopping_restrictions', 'users',
  ]);

  const before = (await db.query('SELECT COUNT(*) AS n FROM schema_migrations')).rows[0].n;
  const applied = await runMigrations(db); // running again must be a no-op
  const after = (await db.query('SELECT COUNT(*) AS n FROM schema_migrations')).rows[0].n;
  assert.deepEqual(applied, []);
  assert.equal(before, after);
});

test('two processes migrating at once do not both apply the same file', async () => {
  const db = await resetDatabase();
  await db.query("DELETE FROM schema_migrations");
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const results = await Promise.all([runMigrations(db), runMigrations(db)]);
  const appliedCounts = results.map((applied) => applied.length).sort();
  assert.deepEqual(appliedCounts, [0, 3], 'exactly one of them applied the migrations');
});
