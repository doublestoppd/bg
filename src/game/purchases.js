import { GameRuleError } from './errors.js';
import { findShop, findOffer } from './shops.js';
import { spendCoins } from './currency.js';
import { grantItem } from './inventory.js';

// ----- Tunable rules -----
// The most of one item a single purchase may buy. The 999 stack limit in
// game/inventory.js still applies on top of this.
export const MAX_PURCHASE_QUANTITY = 99;

// Buys `quantity` of an item from a shop. The price comes from the shop
// catalog, never from the caller. Coins leave, items arrive and the ledger
// row is written inside one transaction, so a failure at any step (not
// enough coins, a full stack) leaves everything as it was.
export function purchaseItem(db, userId, { shopId, itemId, quantity }) {
  const shop = findShop(shopId);
  if (!shop) {
    throw new GameRuleError('There is no such shop.');
  }
  const offer = findOffer(shopId, itemId);
  if (!offer) {
    throw new GameRuleError(`${shop.name} does not sell that.`);
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    throw new GameRuleError(`You can buy between 1 and ${MAX_PURCHASE_QUANTITY} at a time.`);
  }

  const totalCost = offer.price * quantity;

  return db.transaction(() => {
    const balance = spendCoins(db, userId, totalCost, {
      reason: 'purchase',
      shopId: shop.id,
      itemId: offer.item.id,
      quantity,
    });
    grantItem(db, userId, offer.item.id, quantity);
    return { shop, item: offer.item, quantity, unitPrice: offer.price, totalCost, balance };
  })();
}
