import { deleteExpiredSessions } from './db/sessions.js';
import { deleteCountersBefore } from './db/request-counters.js';
import { restockDueShops } from './game/restocking.js';
import { pruneActivityLog } from './game/activity.js';

// Background jobs that run inside the web server process. Each job is a
// plain async function; a failing job is logged and tried again next time.
// Timers are unref'd so they never keep a process alive. All coordination
// between processes happens in PostgreSQL (row locks), so any number of
// processes may run this at once.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const HOUSEKEEPING_INTERVAL_MS = 15 * 60 * 1000;

// restockIntervalMs comes from config (RESTOCK_CHECK_INTERVAL_MS).
export function startScheduler(pool, { restockIntervalMs }) {
  const restockJob = {
    name: 'restock shops',
    run: async () => {
      for (const result of await restockDueShops(pool)) {
        if (result.restocked) console.log(`Restocked ${result.shopId} with ${result.listings.length} listings`);
      }
    },
  };
  const housekeepingJobs = [
    { name: 'expire sessions', run: () => deleteExpiredSessions(pool) },
    { name: 'prune request counters', run: () => deleteCountersBefore(pool, new Date(Date.now() - ONE_DAY_MS)) },
    { name: 'prune shop activity log', run: () => pruneActivityLog(pool) },
  ];

  let restocking = false; // never overlap two restock checks in one process
  async function runRestocks() {
    if (restocking) return;
    restocking = true;
    try {
      await runJob(restockJob);
    } finally {
      restocking = false;
    }
  }

  async function runHousekeeping() {
    for (const job of housekeepingJobs) await runJob(job);
  }

  const timers = [setInterval(runRestocks, restockIntervalMs), setInterval(runHousekeeping, HOUSEKEEPING_INTERVAL_MS)];
  for (const timer of timers) timer.unref();
  return { stop: () => timers.forEach((timer) => clearInterval(timer)) };
}

async function runJob(job) {
  try {
    await job.run();
  } catch (error) {
    console.error(`Scheduler job "${job.name}" failed:`, error.message);
  }
}
