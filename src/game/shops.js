import { findItem } from './items.js';

// The shop catalog. Shops are run by the game (not by players) and have
// unlimited stock. This file is hand-edited design content, like species
// and items.
//
// To add a shop, append an object to the list below and restart the
// server. Rules:
//   * id is a lowercase slug that never changes; it appears in URLs and
//     in the coin ledger.
//   * image is the shopkeeper or storefront picture, a URL path such as
//     '/images/shops/questionable-grocer.png', or null for a placeholder.
//   * merchandise lists what the shop sells: { itemId, price }. The item
//     must exist in src/game/items.js and be obtainable. Prices are set
//     here, per shop, never on the item itself, so two shops may sell the
//     same thing at different prices.
//
// To change a price, edit the number. To stop selling something, remove
// its line; players keep what they already bought.

export const MAX_PRICE = 1_000_000;

const shops = [
  {
    id: 'questionable-grocer',
    name: 'The Questionable Grocer',
    description: 'Groceries of uncertain provenance, sold by a grocer of uncertain species.',
    keeper: 'Everything is fresh. Define fresh.',
    image: null,
    merchandise: [
      { itemId: 'soggy-biscuit', price: 5 },
      { itemId: 'humming-turnip', price: 12 },
      { itemId: 'fizzing-pebble', price: 20 },
      { itemId: 'pickled-moonbeam', price: 60 },
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

// What a given shop charges for a given item, with the item definition
// attached, or null if the shop does not sell it.
export function findOffer(shopId, itemId) {
  const shop = findShop(shopId);
  if (!shop) return null;
  const offer = shop.merchandise.find((entry) => entry.itemId === itemId);
  return offer ? { ...offer, item: findItem(offer.itemId) } : null;
}

// Catches catalog mistakes at startup.
function validateShops(list) {
  const seenShops = new Set();
  for (const shop of list) {
    if (!/^[a-z0-9-]+$/.test(shop.id)) throw new Error(`Shop id "${shop.id}" must be a lowercase slug`);
    if (seenShops.has(shop.id)) throw new Error(`Duplicate shop id "${shop.id}"`);
    seenShops.add(shop.id);
    if (!shop.name || !shop.description) throw new Error(`Shop "${shop.id}" needs a name and description`);

    const seenItems = new Set();
    for (const { itemId, price } of shop.merchandise) {
      const item = findItem(itemId);
      if (!item) throw new Error(`Shop "${shop.id}" sells unknown item "${itemId}"`);
      if (!item.obtainable) throw new Error(`Shop "${shop.id}" sells "${itemId}", which is no longer obtainable`);
      if (seenItems.has(itemId)) throw new Error(`Shop "${shop.id}" lists "${itemId}" twice`);
      seenItems.add(itemId);
      if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) {
        throw new Error(`Shop "${shop.id}" price for "${itemId}" must be a whole number from 1 to ${MAX_PRICE}`);
      }
    }
  }
}
