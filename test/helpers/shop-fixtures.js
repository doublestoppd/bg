import { lowRandom } from './fixed-random.js';
import { findShop } from '../../src/game/shops.js';
import { restockShopWithDefinition } from '../../src/game/restocking.js';

// Restocks the grocer with exactly one listing of the given item at a
// fixed quantity and price, so a test can reason about the shelf exactly.
// Override any of the entry's fields through `overrides`.
export async function stockOne(db, itemId, overrides = {}) {
  const grocer = findShop('questionable-grocer');
  const entry = grocer.restockPool.find((e) => e.itemId === itemId);
  const { quantity = 2, price = 20, ...rest } = overrides;
  const definition = {
    ...grocer,
    restock: { ...grocer.restock, listingsMin: 1, listingsMax: 1 },
    restockPool: [{ ...entry, quantity: [quantity, quantity], price: [price, price], maxPerPurchase: 3, maxPerRestock: 5, dailySupplyCap: undefined, ...rest }],
  };
  const result = await restockShopWithDefinition(db, definition, { force: true, random: lowRandom });
  return result.listings[0];
}
