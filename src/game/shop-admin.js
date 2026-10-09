import { allShops, findShop } from './shops.js';
import { restockShop } from './restocking.js';
import { logShopActivity } from './activity.js';
import { allShopStates, findShopState, setShopPaused } from '../db/shop-state.js';
import { findRestockEvents } from '../db/shop-restock-events.js';
import { findActiveListings } from '../db/shop-stock.js';
import { findPurchasesByShop, findPurchasesByUser } from '../db/shop-purchases.js';
import { findUserByUsername } from '../db/users.js';
import { insertRestriction, liftRestrictions, findRestrictionsByUser } from '../db/restrictions.js';
import { findActivityByUser, findBusiestAccounts } from '../db/activity-log.js';

// Operations an administrator performs on shops and accounts, used by
// scripts/shop-admin.js. Every action records who did it: restocks in
// shop_restock_events.triggered_by, everything else in shop_activity_log
// with kind 'admin_*'. `operator` is the administrator's name as given on
// the command line; it is written as 'admin:<name>'.

export async function listShops(pool) {
  const states = await allShopStates(pool);
  return allShops().map((shop) => {
    const state = states.find((s) => s.shop_id === shop.id) || null;
    return {
      id: shop.id,
      name: shop.name,
      paused: state ? state.paused : null,
      lastRestockAt: state && state.last_restock_at,
      nextRestockAt: state && state.next_restock_at,
      currentRestockId: state && state.current_restock_id,
    };
  });
}

export async function shopStock(pool, shopId) {
  requireShop(shopId);
  return { state: await findShopState(pool, shopId), listings: await findActiveListings(pool, shopId) };
}

// `limit` is optional throughout; the db functions hold the defaults.
export async function shopHistory(pool, shopId, limit) {
  requireShop(shopId);
  return findRestockEvents(pool, shopId, limit);
}

export async function shopPurchases(pool, shopId, limit) {
  requireShop(shopId);
  return findPurchasesByShop(pool, shopId, limit);
}

export async function pauseShop(pool, shopId, operator) {
  requireShop(shopId);
  await setShopPaused(pool, shopId, true);
  await logShopActivity(pool, { kind: 'admin_pause', shopId, details: { by: adminName(operator) } });
}

export async function resumeShop(pool, shopId, operator) {
  requireShop(shopId);
  await setShopPaused(pool, shopId, false);
  await logShopActivity(pool, { kind: 'admin_resume', shopId, details: { by: adminName(operator) } });
}

// A manual restock goes through exactly the same function as the
// scheduler, so it obeys the lock, the caps and the catalog.
export async function manualRestock(pool, shopId, operator) {
  requireShop(shopId);
  return restockShop(pool, shopId, { force: true, triggeredBy: adminName(operator) });
}

export async function restrictAccount(pool, username, { reason, hours = null }, operator) {
  const user = await requireUser(pool, username);
  if (!reason) throw new Error('A restriction needs a reason');
  const expiresAt = hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
  const restriction = await insertRestriction(pool, { userId: user.id, reason, createdBy: adminName(operator), expiresAt });
  await logShopActivity(pool, { userId: user.id, kind: 'admin_restrict', details: { by: adminName(operator), reason, expiresAt } });
  return restriction;
}

export async function unrestrictAccount(pool, username, operator) {
  const user = await requireUser(pool, username);
  const lifted = await liftRestrictions(pool, user.id, adminName(operator));
  await logShopActivity(pool, { userId: user.id, kind: 'admin_unrestrict', details: { by: adminName(operator), lifted } });
  return lifted;
}

// Everything worth reading about one account's shopping.
export async function accountReport(pool, username, limit) {
  const user = await requireUser(pool, username);
  return {
    user,
    restrictions: await findRestrictionsByUser(pool, user.id),
    purchases: await findPurchasesByUser(pool, user.id),
    activity: await findActivityByUser(pool, user.id, limit),
  };
}

// Accounts with the most logged shop events in the last `hours`.
export async function suspiciousAccounts(pool, hours = 24, limit) {
  return findBusiestAccounts(pool, new Date(Date.now() - hours * 60 * 60 * 1000), limit);
}

function requireShop(shopId) {
  if (!findShop(shopId)) throw new Error(`No shop "${shopId}". Known shops: ${allShops().map((s) => s.id).join(', ')}`);
}

async function requireUser(pool, username) {
  const user = await findUserByUsername(pool, username);
  if (!user) throw new Error(`No account named "${username}"`);
  return user;
}

function adminName(operator) {
  if (!operator || !/^[A-Za-z0-9_.-]{1,40}$/.test(operator)) {
    throw new Error('Give the administrator\'s name with --by <name> so the action can be audited');
  }
  return `admin:${operator}`;
}
