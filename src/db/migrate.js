import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// An arbitrary fixed number identifying "Blobgarden is migrating" to
// pg_advisory_lock, so two server processes starting at once cannot both
// try to apply the same migration.
const MIGRATION_LOCK_KEY = 7_201_995;

// Applies every .sql file in src/db/migrations that has not been applied
// yet, in filename order. The schema_migrations table remembers which files
// have run, so running this on every startup is safe. Each file runs inside
// its own transaction, so a broken migration leaves nothing half-applied.
export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    const appliedNow = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
      appliedNow.push(file);
    }
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
