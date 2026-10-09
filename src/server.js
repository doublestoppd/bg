import config, { requireDatabaseUrl } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { syncItemCatalog } from './game/items.js';
import { ensureShopStates } from './game/restocking.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';

const pool = createPool(requireDatabaseUrl());
await runMigrations(pool);
await syncItemCatalog(pool); // keep the items table in step with src/game/items.js
await ensureShopStates(pool); // every catalog shop gets a schedule row (existing ones untouched)

const app = createApp({ db: pool });
const scheduler = config.schedulerEnabled
  ? startScheduler(pool, { restockIntervalMs: config.restockIntervalMs })
  : { stop() {} };

const server = app.listen(config.port, () => {
  console.log(`Game running at http://localhost:${config.port}`);
});

// Stop taking requests, finish the ones in flight, then close the pool.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  scheduler.stop();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
