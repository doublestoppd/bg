import crypto from 'node:crypto';
import { allShops, findShop } from './shops.js';
import { listingMaxQuantity } from './purchases.js';
import { withTransaction } from '../db/pool.js';
import { ensureShopState, lockShopStateSkipLocked, recordRestock, findShopState } from '../db/shop-state.js';
import { insertRestockEvent, setRestockListingCount, supersedeRestocks } from '../db/shop-restock-events.js';
import { insertListing, deactivateListings, findActiveListings } from '../db/shop-stock.js';
import { reserveDailySupply } from '../db/daily-supply.js';

// Restocking: when a shop is due, replace its limited listings with a new
// random assortment drawn from its restockPool, and schedule the next one.
//
// Everything here is driven by PostgreSQL state (shop_state), never by
// memory, so a restart changes nothing and several server processes can
// run the scheduler at once: the shop row is locked for the duration of a
// restock and other workers skip a locked shop.
//
// Randomness is injectable for tests. Production uses crypto.randomInt.
// A `random` has one method: int(min, max), inclusive on both ends.

const secureRandom = {
  int: (min, max) => crypto.randomInt(min, max + 1),
};

// Creates the shop_state row for every catalog shop that lacks one. New
// shops are due at once, so they fill on the scheduler's first tick.
export async function ensureShopStates(pool, now = new Date()) {
  for (const shop of allShops()) {
    await ensureShopState(pool, shop.id, now);
  }
}

// Restocks every shop whose time has come. Returns one result per shop.
export async function restockDueShops(pool, options = {}) {
  const results = [];
  for (const shop of allShops()) {
    results.push(await restockShop(pool, shop.id, options));
  }
  return results;
}

// Restocks one shop if it is due (or unconditionally with force: true, as
// an administrator does). Returns { shopId, restocked, skipped?, event?,
// listings? }.
//
// Missed restocks: if the server was down past the scheduled time, the
// shop is simply "due" and gets exactly one restock on the next tick, with
// the following one scheduled from now. Missed restocks are never made up,
// so downtime cannot flood the economy with scarce items.
export async function restockShop(pool, shopId, options = {}) {
  const shop = findShop(shopId);
  if (!shop) throw new Error(`No shop "${shopId}"`);
  return restockShopWithDefinition(pool, shop, options);
}

// The same, for a shop definition supplied by the caller rather than
// looked up in the catalog. Tests use this to force particular pool
// contents; everything else should call restockShop.
export async function restockShopWithDefinition(pool, shop, { force = false, triggeredBy = 'scheduler', now = new Date(), random = secureRandom } = {}) {
  const shopId = shop.id;
  return withTransaction(pool, async (db) => {
    const state = await lockShopStateSkipLocked(db, shopId);
    if (!state) return { shopId, restocked: false, skipped: 'another worker is restocking this shop' };
    if (!force && state.paused) return { shopId, restocked: false, skipped: 'paused' };
    if (!force && state.next_restock_at > now) return { shopId, restocked: false, skipped: 'not due' };

    // Retire the previous assortment first. Deactivating takes a lock on
    // each old listing, so any purchase in progress on one of them finishes
    // (or fails) before it disappears.
    await deactivateListings(db, shopId);
    await supersedeRestocks(db, shopId, now);

    const event = await insertRestockEvent(db, { shopId, triggeredBy, createdAt: now });
    const supplyDate = now.toISOString().slice(0, 10); // UTC day
    const listings = [];
    for (const planned of planRestock(shop, random)) {
      let quantity = planned.quantity;
      if (planned.dailySupplyCap !== undefined) {
        quantity = await reserveDailySupply(db, planned.itemId, supplyDate, quantity, planned.dailySupplyCap);
        if (quantity === 0) continue; // the cap is spent for today
      }
      listings.push(await insertListing(db, {
        shopId,
        restockId: event.id,
        itemId: planned.itemId,
        unitPrice: planned.unitPrice,
        quantity,
        maxPerPurchase: planned.maxPerPurchase,
        maxPerAccount: planned.maxPerRestock,
      }));
    }
    await setRestockListingCount(db, event.id, listings.length);

    const minutes = random.int(shop.restock.minMinutes, shop.restock.maxMinutes);
    const nextRestockAt = new Date(now.getTime() + minutes * 60 * 1000);
    await recordRestock(db, shopId, { restockedAt: now, nextRestockAt, restockId: event.id });

    return { shopId, restocked: true, event: { ...event, listing_count: listings.length }, listings, nextRestockAt };
  });
}

// Decides what a restock contains, without touching the database:
// how many distinct listings, which pool entries (weighted, no repeats),
// and each one's quantity and price. Exported so tests can check it with
// a deterministic `random`.
//
// Each listing is drawn in turn with probability proportional to weight
// among the entries not yet chosen. The weights therefore only decide
// anything when fewer listings are drawn than the pool holds; the catalog
// validation in shops.js guarantees that for every real shop.
export function planRestock(shop, random) {
  const pool = [...shop.restockPool];
  if (pool.length > 1 && shop.restock.listingsMax >= pool.length) {
    throw new Error(`Shop "${shop.id}" would list its whole pool: restock.listingsMax must be smaller than the pool`);
  }
  const wanted = Math.min(random.int(shop.restock.listingsMin, shop.restock.listingsMax), pool.length);
  const chosen = [];
  while (chosen.length < wanted && pool.length > 0) {
    const entry = pool.splice(pickWeightedIndex(pool, random), 1)[0];
    const [qLo, qHi] = entry.quantity;
    const [pLo, pHi] = entry.price;
    chosen.push({
      itemId: entry.itemId,
      quantity: random.int(qLo, qHi),
      unitPrice: random.int(pLo, pHi),
      maxPerPurchase: entry.maxPerPurchase,
      maxPerRestock: entry.maxPerRestock,
      dailySupplyCap: entry.dailySupplyCap,
    });
  }
  return chosen;
}

// Picks an index with probability proportional to each entry's weight:
// draw a number below the total weight and walk the cumulative sums.
function pickWeightedIndex(entries, random) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random.int(0, total - 1);
  for (let i = 0; i < entries.length; i++) {
    roll -= entries[i].weight;
    if (roll < 0) return i;
  }
  return entries.length - 1;
}

// What a visitor sees in a shop: the current listings, each with the most
// a purchase may take, plus whether a restock is coming. The exact time of
// the next restock is deliberately not returned.
export async function shopMerchandise(pool, shopId) {
  const shop = findShop(shopId);
  if (!shop) throw new Error(`No shop "${shopId}"`);
  const state = await findShopState(pool, shopId);
  const listings = await findActiveListings(pool, shopId);
  return {
    listings: listings.map((listing) => ({ ...listing, maxQuantity: listingMaxQuantity(listing) })),
    currentRestockId: state ? state.current_restock_id : null,
    paused: state ? state.paused : false,
    lastRestockAt: state ? state.last_restock_at : null,
  };
}
