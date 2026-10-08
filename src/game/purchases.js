import crypto from 'node:crypto';
import { GameRuleError } from './errors.js';
import { findShop, findEssential, findPoolEntry } from './shops.js';
import { spendCoins } from './currency.js';
import { grantItem } from './inventory.js';
import { findItem } from './items.js';
import { assertEligible } from './eligibility.js';
import { SHOP_LIMITS } from './shop-limits.js';
import { withTransaction, PG_DEADLOCK, PG_SERIALIZATION_FAILURE, PG_UNIQUE_VIOLATION } from '../db/pool.js';
import { lockUser } from '../db/users.js';
import { insertPurchase, findPurchaseByKey, sumPurchasedFromListing, countListingPurchasesSince } from '../db/shop-purchases.js';
import { lockListing, decrementListing } from '../db/shop-stock.js';

// ----- Tunable rules -----
// A hard ceiling on one purchase, above any entry's own maxPerPurchase.
// The 999 stack limit in game/inventory.js still applies on top of this.
export const MAX_PURCHASE_QUANTITY = 99;
// How many times a purchase is retried after a PostgreSQL deadlock. The
// request id makes a retry safe: it can never buy twice.
const DEADLOCK_RETRIES = 2;

// Buys from a shop. Exactly one of these must be given:
//   itemId     an essential (always in stock at its catalog price)
//   listingId  a limited listing from the current restock (shop_stock.id)
// plus:
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
function checkRequest({ shopId, itemId, listingId, quantity, shownPrice, requestId }) {
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
  const hasItem = itemId !== undefined && itemId !== null && itemId !== '';
  const listing = Number(listingId);
  const hasListing = listingId !== undefined && listingId !== null && listingId !== '';
  if (hasItem === hasListing) {
    throw new GameRuleError('Choose one thing to buy.', 'bad_request');
  }
  if (hasListing && !Number.isSafeInteger(listing)) {
    throw new GameRuleError(`${shop.name} does not sell that.`, 'bad_request');
  }
  return { shop, itemId: hasItem ? String(itemId) : null, listingId: hasListing ? listing : null, quantity, shownPrice, requestId };
}

async function runPurchase(db, userId, { shop, itemId, listingId, quantity, shownPrice, requestId }) {
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
  const requestHash = hashPurchase({ shopId: shop.id, itemId, listingId, quantity, unitPrice: shownPrice });
  const previous = await findPurchaseByKey(db, userId, requestId);
  if (previous) {
    if (previous.request_hash !== requestHash) {
      throw new GameRuleError('That purchase form was already used for something else.', 'bad_request');
    }
    return describe(previous, shop, { item: findItem(previous.item_id) }, { repeated: true, balance: null });
  }

  // Lock order 2: the listing, if buying limited stock.
  const offer = listingId === null
    ? essentialOffer(shop, itemId, quantity)
    : await listingOffer(db, shop, listingId, quantity, user);

  if (offer.unitPrice !== shownPrice) {
    throw new GameRuleError(`The price of ${offer.item.name} has changed since you looked. Please check the new price.`, 'price_changed');
  }

  const totalCost = offer.unitPrice * quantity;
  const purchase = await insertPurchase(db, {
    userId, shopId: shop.id, itemId: offer.item.id, quantity,
    unitPrice: offer.unitPrice, totalCost, idempotencyKey: requestId, requestHash,
    stockId: listingId, restockId: offer.restockId,
  });
  if (listingId !== null && (await decrementListing(db, listingId, quantity)) !== 1) {
    // Cannot happen while we hold the listing's lock, but the stock must
    // never be allowed to go negative whatever else changes.
    throw new GameRuleError(`${offer.item.name} has just sold out.`, 'sold_out');
  }
  const balance = await spendCoins(db, userId, totalCost, {
    reason: 'purchase', shopId: shop.id, itemId: offer.item.id, quantity, purchaseId: purchase.id,
  });
  await grantItem(db, userId, offer.item.id, quantity);
  return describe(purchase, shop, offer, { repeated: false, balance, remaining: offer.remaining === null ? null : offer.remaining - quantity });
}

// An essential: catalog price, no stock to check.
function essentialOffer(shop, itemId, quantity) {
  const essential = findEssential(shop.id, itemId);
  if (!essential) {
    throw new GameRuleError(`${shop.name} does not sell that.`, 'bad_request');
  }
  const maxQuantity = Math.min(essential.maxPerPurchase, MAX_PURCHASE_QUANTITY);
  if (quantity > maxQuantity) {
    throw new GameRuleError(`You can buy at most ${maxQuantity} ${essential.item.name} at a time.`, 'limit_exceeded');
  }
  return { item: essential.item, unitPrice: essential.price, restockId: null, remaining: null };
}

// A limited listing: locked, must be live, in stock, within limits, and
// the player must be allowed to buy it. The checks run from cheapest to
// most specific so the message tells the player the most useful thing.
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
  if (quantity > listing.max_per_purchase) {
    throw new GameRuleError(`You can buy at most ${listing.max_per_purchase} ${item.name} at a time.`, 'limit_exceeded');
  }

  // Who may buy: no restriction in force, and the entry's own rules.
  await assertEligible(db, user, findPoolEntry(shop.id, listing.item_id));

  // How much, per account: this listing, and limited stock in general.
  const alreadyBought = await sumPurchasedFromListing(db, user.id, listing.id);
  if (alreadyBought + quantity > listing.max_per_account) {
    throw new GameRuleError(`You can buy at most ${listing.max_per_account} ${item.name} from this restock, and you have ${alreadyBought}.`, 'limit_exceeded');
  }
  const recent = await countListingPurchasesSince(db, user.id, new Date(Date.now() - 60 * 60 * 1000));
  if (recent >= SHOP_LIMITS.listingPurchasesPerHour) {
    throw new GameRuleError(`You have bought ${recent} limited items in the last hour, which is the most allowed. Please come back later.`, 'limit_exceeded');
  }

  return { item, unitPrice: listing.unit_price, restockId: listing.restock_id, remaining: listing.remaining_quantity };
}

function describe(purchase, shop, offer, { repeated, balance, remaining = null }) {
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
