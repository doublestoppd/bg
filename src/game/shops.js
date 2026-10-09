import { findItem, RARITIES } from './items.js';

// The shop catalog. Shops are run by the game (not by players). This file
// is hand-edited design content, like species and items; live stock,
// schedules and history live in PostgreSQL (see docs/SHOPS.md).
//
// Each shop has two kinds of merchandise:
//
//   essentials   always in stock at a fixed price, unlimited, available to
//                everyone. Ordinary food belongs here.
//   restockPool  the limited merchandise. Each restock picks a few entries
//                from this pool by weight, gives each a quantity and a
//                price drawn from its ranges, and the listings are shared
//                by every player until they sell out or the next restock
//                replaces them.
//
// Entry fields:
//   itemId           an id from src/game/items.js (must be obtainable)
//   price            essentials: the fixed price
//   price: [lo, hi]  pool: each restock draws a price in this range
//   weight           pool: relative chance of being picked (any positive
//                    whole number; 10 is twice as likely as 5). Weights
//                    only matter when a restock picks far fewer listings
//                    than the pool holds, so restock.listingsMax may be at
//                    most half the pool size (see validation below).
//   quantity: [lo, hi]  pool, optional: copies per restock. Defaults by the
//                    item's rarity to RARITY_QUANTITY_RANGES below.
//   maxPerPurchase   most copies in one purchase
//   maxPerRestock    pool: most copies one account may buy from one listing
//   dailySupplyCap   pool, optional: most copies restocks may create across
//                    all shops per UTC day
//   eligibility      pool, optional: { minAccountAgeHours, requiresPet }
//
// Rarity is descriptive. It never sets a price or a weight; only the
// default quantity range reads it, and an entry can override that.
//
// To add a shop, append an object and restart the server. To change a
// price, edit the number. To stop selling something, remove its entry;
// players keep what they already bought. Adding artwork: set headerImage
// and keeper.image to paths under src/public/images/.

export const MAX_PRICE = 1_000_000;
export const MAX_LISTING_QUANTITY = 999;

// Default copies per restock when a pool entry gives no quantity range.
export const RARITY_QUANTITY_RANGES = {
  common: [4, 12],
  uncommon: [2, 5],
  rare: [1, 2],
};

const shops = [
  {
    id: 'questionable-grocer',
    name: 'The Questionable Grocer',
    description: 'Groceries of uncertain provenance, sold by a grocer of uncertain species.',
    headerImage: null,
    keeper: {
      name: 'Mungle',
      image: null,
      lines: [
        'Everything is fresh. Define fresh.',
        'The turnips hum. Do not ask them why.',
        'No refunds. No questions. No sudden movements.',
      ],
    },
    // One listing per restock while the pool has only three entries: the
    // pebble (weight 10 of 14) appears in about 71% of restocks, the
    // moonbeam (3) in 21%, the jar (1) in 7%. A restock may never draw
    // more than half the pool (validation enforces it), because once most
    // of the pool is drawn every time, the weights stop meaning anything
    // and rare entries show up in every restock. Grow the pool before
    // raising listingsMax.
    restock: {
      minMinutes: 8,
      maxMinutes: 18,
      listingsMin: 1,
      listingsMax: 1,
    },
    essentials: [
      { itemId: 'soggy-biscuit', price: 5, maxPerPurchase: 20 },
      { itemId: 'humming-turnip', price: 12, maxPerPurchase: 10 },
    ],
    restockPool: [
      { itemId: 'fizzing-pebble', weight: 10, price: [18, 24], maxPerPurchase: 3, maxPerRestock: 5 },
      { itemId: 'pickled-moonbeam', weight: 3, price: [55, 80], maxPerPurchase: 1, maxPerRestock: 2 },
      {
        itemId: 'unlabelled-jar',
        weight: 1,
        price: [300, 450],
        maxPerPurchase: 1,
        maxPerRestock: 1,
        dailySupplyCap: 4,
        eligibility: { minAccountAgeHours: 24, requiresPet: true },
      },
    ],
  },
];

validateShops(shops);

export function allShops() {
  return shops;
}

export function findShop(id) {
  return shops.find((shop) => shop.id === id) || null;
}

// An essential the shop sells, with the item attached, or null.
export function findEssential(shopId, itemId) {
  const shop = findShop(shopId);
  return withItem(shop && shop.essentials.find((e) => e.itemId === itemId));
}

// The pool configuration for an item in a shop, with the item attached,
// or null. Used to read limits and eligibility for a stock listing.
export function findPoolEntry(shopId, itemId) {
  const shop = findShop(shopId);
  return withItem(shop && shop.restockPool.find((e) => e.itemId === itemId));
}

function withItem(entry) {
  return entry ? { ...entry, item: findItem(entry.itemId) } : null;
}

// The quantity range a pool entry restocks with.
export function quantityRangeFor(entry) {
  return entry.quantity || RARITY_QUANTITY_RANGES[findItem(entry.itemId).rarity];
}

// Catches catalog mistakes at startup instead of in front of a player.
function validateShops(list) {
  const seenShops = new Set();
  for (const shop of list) {
    const where = `Shop "${shop.id}"`;
    if (!/^[a-z0-9-]+$/.test(shop.id)) throw new Error(`${where}: id must be a lowercase slug`);
    if (seenShops.has(shop.id)) throw new Error(`Duplicate shop id "${shop.id}"`);
    seenShops.add(shop.id);
    if (!shop.name || !shop.description) throw new Error(`${where} needs a name and description`);
    if (!shop.keeper || !shop.keeper.name || !Array.isArray(shop.keeper.lines) || shop.keeper.lines.length === 0) {
      throw new Error(`${where} needs a keeper with a name and at least one line`);
    }

    const r = shop.restock;
    if (!r || !isWholeNumber(r.minMinutes, 1) || !isWholeNumber(r.maxMinutes, r.minMinutes)) {
      throw new Error(`${where}: restock.minMinutes and maxMinutes must be whole numbers with min <= max`);
    }
    if (!isWholeNumber(r.listingsMin, 0) || !isWholeNumber(r.listingsMax, r.listingsMin)) {
      throw new Error(`${where}: restock.listingsMin and listingsMax must be whole numbers with min <= max`);
    }
    const poolSize = (shop.restockPool || []).length;
    if (poolSize > 0 && r.listingsMax < 1) {
      throw new Error(`${where}: restock.listingsMax must be at least 1 when the pool is not empty`);
    }
    // A restock that takes most of the pool makes the weights meaningless:
    // with three entries and two listings, every restock holds two of the
    // three and a "rare" entry appears most of the time. So a restock may
    // draw at most half the pool. Grow the pool before raising listingsMax.
    const mostAllowed = Math.max(1, Math.floor(poolSize / 2));
    if (poolSize > 0 && r.listingsMax > mostAllowed) {
      throw new Error(`${where}: restock.listingsMax (${r.listingsMax}) may be at most half the restock pool (${poolSize} entries, so at most ${mostAllowed}), or rare entries would appear in most restocks`);
    }

    const seenItems = new Set();
    const checkItem = (entry) => {
      const item = findItem(entry.itemId);
      if (!item) throw new Error(`${where} sells unknown item "${entry.itemId}"`);
      if (!item.obtainable) throw new Error(`${where} sells "${entry.itemId}", which is no longer obtainable`);
      if (seenItems.has(entry.itemId)) throw new Error(`${where} lists "${entry.itemId}" twice`);
      seenItems.add(entry.itemId);
      if (!isWholeNumber(entry.maxPerPurchase, 1) || entry.maxPerPurchase > MAX_LISTING_QUANTITY) {
        throw new Error(`${where}: "${entry.itemId}" needs maxPerPurchase from 1 to ${MAX_LISTING_QUANTITY}`);
      }
    };

    for (const entry of shop.essentials || []) {
      checkItem(entry);
      if (!isWholeNumber(entry.price, 1) || entry.price > MAX_PRICE) {
        throw new Error(`${where}: essential "${entry.itemId}" price must be a whole number from 1 to ${MAX_PRICE}`);
      }
    }

    for (const entry of shop.restockPool || []) {
      checkItem(entry);
      if (!isWholeNumber(entry.weight, 1)) throw new Error(`${where}: "${entry.itemId}" weight must be a positive whole number`);
      checkRange(entry.price, 1, MAX_PRICE, `${where}: "${entry.itemId}" price`);
      if (entry.quantity !== undefined) checkRange(entry.quantity, 1, MAX_LISTING_QUANTITY, `${where}: "${entry.itemId}" quantity`);
      if (!isWholeNumber(entry.maxPerRestock, 1)) throw new Error(`${where}: "${entry.itemId}" needs maxPerRestock >= 1`);
      if (entry.dailySupplyCap !== undefined && !isWholeNumber(entry.dailySupplyCap, 1)) {
        throw new Error(`${where}: "${entry.itemId}" dailySupplyCap must be a positive whole number`);
      }
      const e = entry.eligibility;
      if (e !== undefined) {
        if (typeof e !== 'object' || e === null) throw new Error(`${where}: "${entry.itemId}" eligibility must be an object`);
        if (e.minAccountAgeHours !== undefined && !isWholeNumber(e.minAccountAgeHours, 0)) throw new Error(`${where}: "${entry.itemId}" minAccountAgeHours must be a whole number`);
        if (e.requiresPet !== undefined && typeof e.requiresPet !== 'boolean') throw new Error(`${where}: "${entry.itemId}" requiresPet must be true or false`);
      }
    }
  }
  for (const rarity of Object.keys(RARITY_QUANTITY_RANGES)) {
    if (!RARITIES.includes(rarity)) throw new Error(`RARITY_QUANTITY_RANGES has unknown rarity "${rarity}"`);
  }
}

function isWholeNumber(value, min) {
  return Number.isSafeInteger(value) && value >= min;
}

function checkRange(range, min, max, what) {
  if (!Array.isArray(range) || range.length !== 2 || !isWholeNumber(range[0], min) || !isWholeNumber(range[1], range[0]) || range[1] > max) {
    throw new Error(`${what} must be [low, high] with ${min} <= low <= high <= ${max}`);
  }
}
