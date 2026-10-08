import { insertActivity, deleteActivityBefore } from '../db/activity-log.js';
import { ACTIVITY_LOG_RETENTION_DAYS } from './shop-limits.js';

// Writes one line to the shop activity log. Logging must never break the
// request that triggered it, so failures are reported and swallowed.
export async function logShopActivity(db, entry) {
  try {
    await insertActivity(db, entry);
  } catch (error) {
    console.error('Could not write shop activity:', error.message);
  }
}

// Kinds of refusal worth keeping; anything else is logged as 'refused'.
const NOTABLE_REFUSALS = new Set(['sold_out', 'expired_listing', 'limit_exceeded', 'ineligible', 'restricted', 'price_changed', 'bad_request']);

export function refusalKind(error) {
  return NOTABLE_REFUSALS.has(error.code) ? error.code : 'refused';
}

export async function pruneActivityLog(db, now = new Date()) {
  return deleteActivityBefore(db, new Date(now.getTime() - ACTIVITY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000));
}
