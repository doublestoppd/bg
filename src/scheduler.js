import { deleteExpiredSessions } from './db/sessions.js';
import { deleteCountersBefore } from './db/request-counters.js';

// Background housekeeping that runs inside the web server process. Each
// job is a plain async function; a failing job is logged and tried again
// next tick. The timer is unref'd so it never keeps a process alive.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function startScheduler(pool, { intervalMs = 15 * 60 * 1000 } = {}) {
  const jobs = [
    { name: 'expire sessions', run: () => deleteExpiredSessions(pool) },
    { name: 'prune request counters', run: () => deleteCountersBefore(pool, new Date(Date.now() - ONE_DAY_MS)) },
  ];

  async function tick() {
    for (const job of jobs) {
      try {
        await job.run();
      } catch (error) {
        console.error(`Scheduler job "${job.name}" failed:`, error.message);
      }
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
