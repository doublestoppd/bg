// DEVELOPMENT ONLY. Drops every table in DATABASE_URL and re-runs the
// migrations: `npm run db:reset -- --yes`. Refuses to run in production.
import config, { requireDatabaseUrl } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

if (config.isProduction) {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error('This deletes everything in the database. Run again with --yes to confirm.');
  process.exit(1);
}

const url = requireDatabaseUrl();
const pool = createPool(url);
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const applied = await runMigrations(pool);
  console.log(`Reset ${new URL(url).pathname.slice(1)} and applied: ${applied.join(', ')}`);
} finally {
  await pool.end();
}
