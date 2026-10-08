import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Applies every .sql file in src/db/migrations that has not been applied yet.
// The schema_migrations table remembers which files have run, so starting the
// server repeatedly is safe. Each file runs inside its own transaction.
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name),
  );

  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();

  // Foreign keys are switched off while migrating, as SQLite's own
  // documentation recommends: a migration that rebuilds a table (copy,
  // drop, rename) would otherwise trip the checks halfway through. Each
  // migration then verifies every reference before it commits, so a
  // mistake rolls back rather than leaving orphaned rows.
  db.pragma('foreign_keys = OFF');
  try {
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        const problems = db.pragma('foreign_key_check');
        if (problems.length > 0) {
          throw new Error(`Migration ${file} broke foreign keys: ${JSON.stringify(problems)}`);
        }
        db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
