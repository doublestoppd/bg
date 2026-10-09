import crypto from 'node:crypto';
import { GameRuleError } from './errors.js';
import { findShop, findPoolEntry } from './shops.js';
import { spendCoins } from './currency.js';
import { grantItem } from './inventory.js';
import { findItem } from './items.js';
import { assertEligible } from './eligibility.js';
import { SHOP_LIMITS } from './shop-limits.js';
import { withTransaction, PG_DEADLOCK, PG_SERIALIZATION_FAILURE, PG_UNIQUE_VIOLATION } from '../db/pool.js';
import { lockUser } from '../db/users.js';
import { insertPurchase, findPurchaseByKey, countPurchasesSince } from '../db/shop-purchases.js';
import { lockListing, decrementListing } from '../db/shop-stock.js';

// ----- Tunable rules -----
// A hard ceiling on one purchase, an integer-safety bound rather than a
// game rule. The 999 stack limit in game/inventory.js applies on top.
export const MAX_PURCHASE_QUANTITY = 99;

// The most of a listing one purchase may take right now.
export function listingMaxQuantity(listing) {
  return Math.min(listing.remaining_quantity, MAX_PURCHASE_QUANTITY);
}
// How many times a purchase is retried after a PostgreSQL deadlock. The
// request id makes a retry safe: it can never buy twice.
const DEADLOCK_RETRIES = 2;

// Buys from a shop:
//   listingId  a listing from the current restock (shop_stock.id)
//   quantity   how many
//   shownPrice the unit price the player saw on the page. If the real
//              price differs, the purchase is refused so the player can
//              look again; nobody is ever charged more than they were shown.
//   requestId  the random id printed into the buy form. The same id sent
//              twice (a double click, a retried request) returns the first
//              purchase instead of making another; sent with different
//              details it is refused.
//
// Everything happens in one transaction, with locks taken in a fixed
// order (the player's row, then the listing) so purchases cannot deadlock
// each other. Any failure rolls back coins, stock, items and records
// together. Returns a description of the purchase.
export async function purchaseItem(pool, userId, request) {
  const checked = checkRequest(request);
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(pool, (db) => runPurchase(db, userId, checked));
    } catch (error) {
      // A unique violation on the request id means another copy of this
      // very request committed first; running again returns its result.
      const transient = error.code === PG_DEADLOCK || error.code === PG_SERIALIZATION_FAILURE || error.code === PG_UNIQUE_VIOLATION;
      if (!transient || attempt >= DEADLOCK_RETRIES) throw error;
    }
  }
}

// Validates the shape of the request before any database work.
function checkRequest({ shopId, listingId, quantity, shownPrice, requestId }) {
  const shop = findShop(shopId);
  if (!shop) {
    throw new GameRuleError('There is no such shop.');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    throw new GameRuleError(`You can buy between 1 and ${MAX_PURCHASE_QUANTITY} at a time.`, 'bad_request');
  }
  if (!Number.isSafeInteger(shownPrice) || shownPrice < 1) {
    throw new GameRuleError('That purchase form was out of date. Please try again.', 'bad_request');
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(requestId)) {
    throw new GameRuleError('That purchase form was out of date. Please try again.', 'bad_request');
  }
  if (listingId === undefined || listingId === null || listingId === '' || !Number.isSafeInteger(Number(listingId))) {
    throw new GameRuleError(`${shop.name} does not sell that.`, 'bad_request');
  }
  return { shop, listingId: Number(listingId), quantity, shownPrice, requestId };
}

async function runPurchase(db, userId, { shop, listingId, quantity, shownPrice, requestId }) {
  // Lock order 1: the player's row. This account's purchases now run one
  // at a time, so repeated requests always see the first one's result and
  // per-account limits are counted without races.
  const user = await lockUser(db, userId);
  if (!user) {
    throw new Error(`No user ${userId}`);
  }

  // A repeated request (double click, browser retry, lost response) must
  // get the first purchase back no matter what has happened to the shelf
  // since: sold out, replaced by a restock, repriced. So the request id is
  // checked before the listing is examined at all. The hash is built from
  // the request alone, so a key reused for a different purchase is caught.
  const requestHash = hashPurchase({ shopId: shop.id, listingId, quantity, unitPrice: shownPrice });
  const previous = await findPurchaseByKey(db, userId, requestId);
  if (previous) {
    if (previous.request_hash !== requestHash) {
      throw new GameRuleError('That purchase form was already used for something else.', 'bad_request');
    }
    return describe(previous, shop, { item: findItem(previous.item_id) }, { repeated: true, balance: null });
  }

  // Lock order 2: the listing.
  const offer = await listingOffer(db, shop, listingId, quantity, user);

  if (offer.unitPrice !== shownPrice) {
    throw new GameRuleError(`The price of ${offer.item.name} has changed since you looked. Please check the new price.`, 'price_changed');
  }

  const totalCost = offer.unitPrice * quantity;
  const purchase = await insertPurchase(db, {
    userId, shopId: shop.id, itemId: offer.item.id, quantity,
    unitPrice: offer.unitPrice, totalCost, idempotencyKey: requestId, requestHash,
    stockId: listingId, restockId: offer.restockId,
  });
  if (!(await decrementListing(db, listingId, quantity))) {
    // Cannot happen while we hold the listing's lock, but the stock must
    // never be allowed to go negative whatever else changes.
    throw new GameRuleError(`${offer.item.name} has just sold out.`, 'sold_out');
  }
  const balance = await spendCoins(db, userId, totalCost, {
    reason: 'purchase', shopId: shop.id, itemId: offer.item.id, quantity, purchaseId: purchase.id,
  });
  await grantItem(db, userId, offer.item.id, quantity);
  return describe(purchase, shop, offer, { repeated: false, balance, remaining: offer.remaining - quantity });
}

// The listing: locked, must be live, in stock, within limits, and the
// player must be allowed to buy it. The checks run from cheapest to most
// specific so the message tells the player the most useful thing.
async function listingOffer(db, shop, listingId, quantity, user) {
  const listing = await lockListing(db, listingId);
  if (!listing || listing.shop_id !== shop.id) {
    throw new GameRuleError(`${shop.name} does not sell that.`, 'bad_request');
  }
  const item = findItem(listing.item_id);
  if (!listing.active) {
    throw new GameRuleError(`That ${item.name} listing has gone; the shelves have been restocked since you looked.`, 'expired_listing');
  }
  if (listing.remaining_quantity === 0) {
    throw new GameRuleError(`${item.name} has sold out.`, 'sold_out');
  }
  if (listing.remaining_quantity < quantity) {
    throw new GameRuleError(`Only ${listing.remaining_quantity} ${item.name} left.`, 'sold_out');
  }

  // Who may buy: no restriction in force, and the entry's own rules.
  await assertEligible(db, user, findPoolEntry(shop.id, listing.item_id));

  // How often, per account.
  const recent = await countPurchasesSince(db, user.id, new Date(Date.now() - 60 * 60 * 1000));
  if (recent >= SHOP_LIMITS.purchasesPerHour) {
    throw new GameRuleError(`You have made ${recent} purchases in the last hour, which is the most allowed. Please come back later.`, 'limit_exceeded');
  }

  return { item, unitPrice: listing.unit_price, restockId: listing.restock_id, remaining: listing.remaining_quantity };
}

function describe(purchase, shop, offer, { repeated, balance, remaining = null }) {
  // `remaining` is null for a replayed request: the shelf may have moved on.
  return {
    purchaseId: purchase.id,
    shop,
    item: offer.item,
    quantity: purchase.quantity,
    unitPrice: purchase.unit_price,
    totalCost: purchase.total_cost,
    balance,
    remaining,
    repeated,
  };
}

function hashPurchase(details) {
  return crypto.createHash('sha256').update(JSON.stringify(details)).digest('hex');
}
