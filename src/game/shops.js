import { findItem } from './items.js';

// The shop catalog. Shops are run by the game (not by players). This file
// is hand-edited design content, like species and items; live stock,
// schedules and history live in PostgreSQL (see docs/SHOPS.md).
//
// Everything a shop sells comes through restocks. Each restock picks a
// few entries from the shop's restockPool by weight, gives each a quantity
// and a price drawn from its ranges, and the listings are shared by every
// player until they sell out or the next restock replaces them. Something
// that should be on the shelves most of the time simply gets a high
// weight and a large quantity range.
//
// Entry fields:
//   itemId           an id from src/game/items.js (must be obtainable)
//   weight           relative chance of being picked (any positive whole
//                    number; 10 is twice as likely as 5). Weights only
//                    matter when a restock picks far fewer listings than
//                    the pool holds, so restock.listingsMax may be at most
//                    half the pool size (see validation below).
//   quantity: [lo, hi]  copies per restock, drawn each time
//   price: [lo, hi]  each restock draws a price in this range
//   eligibility      optional: { minAccountAgeHours, requiresPet }
//
// Items have no rarity of their own. How scarce something is comes
// entirely from these settings: its weight, its quantity range, which
// shops carry it, and any daily cap. A very low weight makes an item
// turn up seldom; a small quantity range makes it sell out fast.
//
// To add a shop, append an object and restart the server. To change a
// price, edit the number. To stop selling something, remove its entry;
// players keep what they already bought. Adding artwork: set headerImage
// and keeper.image to paths under src/public/images/.

export const MAX_PRICE = 1_000_000;
export const MAX_LISTING_QUANTITY = 999;

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
    // One or two listings per restock from a pool of five. A restock may
    // never draw more than half the pool (validation enforces it), because
    // once most of the pool is drawn every time, the weights stop meaning
    // anything and low-weight entries show up in every restock. Grow the
    // pool before raising listingsMax. With these weights (total 46) the
    // biscuit is on the shelves most of the time, the jar seldom.
    restock: {
      minMinutes: 8,
      maxMinutes: 18,
      listingsMin: 1,
      listingsMax: 2,
    },
    restockPool: [
      { itemId: 'soggy-biscuit', weight: 20, quantity: [8, 15], price: [4, 6] },
      { itemId: 'humming-turnip', weight: 12, quantity: [4, 8], price: [10, 14] },
      { itemId: 'fizzing-pebble', weight: 10, quantity: [2, 5], price: [18, 24] },
      { itemId: 'pickled-moonbeam', weight: 3, quantity: [1, 2], price: [55, 80] },
      {
        itemId: 'unlabelled-jar',
        weight: 1,
        quantity: [2, 5],
        price: [300, 450],
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

// The pool configuration for an item in a shop, with the item attached,
// or null. Used to read limits and eligibility for a stock listing.
export function findPoolEntry(shopId, itemId) {
  const shop = findShop(shopId);
  const entry = shop && shop.restockPool.find((e) => e.itemId === itemId);
  return entry ? { ...entry, item: findItem(entry.itemId) } : null;
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
    if (poolSize === 0) throw new Error(`${where} has nothing in its restock pool`);
    if (r.listingsMax < 1) throw new Error(`${where}: restock.listingsMax must be at least 1`);
    // A restock that takes most of the pool makes the weights meaningless:
    // with three entries and two listings, every restock holds two of the
    // three and a low-weight entry appears most of the time. So a restock
    // may draw at most half the pool. Grow the pool before raising
    // listingsMax.
    const mostAllowed = Math.max(1, Math.floor(poolSize / 2));
    if (poolSize > 0 && r.listingsMax > mostAllowed) {
      throw new Error(`${where}: restock.listingsMax (${r.listingsMax}) may be at most half the restock pool (${poolSize} entries, so at most ${mostAllowed}), or low-weight entries would appear in most restocks`);
    }

    const seenItems = new Set();
    for (const entry of shop.restockPool) {
      const item = findItem(entry.itemId);
      if (!item) throw new Error(`${where} sells unknown item "${entry.itemId}"`);
      if (!item.obtainable) throw new Error(`${where} sells "${entry.itemId}", which is no longer obtainable`);
      if (seenItems.has(entry.itemId)) throw new Error(`${where} lists "${entry.itemId}" twice`);
      seenItems.add(entry.itemId);
      if (!isWholeNumber(entry.weight, 1)) throw new Error(`${where}: "${entry.itemId}" weight must be a positive whole number`);
      checkRange(entry.price, 1, MAX_PRICE, `${where}: "${entry.itemId}" price`);
      checkRange(entry.quantity, 1, MAX_LISTING_QUANTITY, `${where}: "${entry.itemId}" quantity`);
      const e = entry.eligibility;
      if (e !== undefined) {
        if (typeof e !== 'object' || e === null) throw new Error(`${where}: "${entry.itemId}" eligibility must be an object`);
        if (e.minAccountAgeHours !== undefined && !isWholeNumber(e.minAccountAgeHours, 0)) throw new Error(`${where}: "${entry.itemId}" minAccountAgeHours must be a whole number`);
        if (e.requiresPet !== undefined && typeof e.requiresPet !== 'boolean') throw new Error(`${where}: "${entry.itemId}" requiresPet must be true or false`);
      }
    }
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
