// Applies pending database migrations: `npm run db:migrate`.
import { requireDatabaseUrl } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

const pool = createPool(requireDatabaseUrl());
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} finally {
  await pool.end();
}
