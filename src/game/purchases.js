import crypto from 'node:crypto';
import { GameRuleError } from './errors.js';
import { findShop, findEssential } from './shops.js';
import { spendCoins } from './currency.js';
import { grantItem } from './inventory.js';
import { withTransaction } from '../db/pool.js';
import { lockUser } from '../db/users.js';
import { insertPurchase, findPurchaseByKey } from '../db/shop-purchases.js';

// ----- Tunable rules -----
// A hard ceiling on one purchase, above any entry's own maxPerPurchase.
// The 999 stack limit in game/inventory.js still applies on top of this.
export const MAX_PURCHASE_QUANTITY = 99;

// Buys `quantity` of one of a shop's essentials. (Limited listings are
// bought through the next milestone's function.) The price comes from the
// shop catalog, never from the caller. Coins leave, items arrive and the
// purchase and ledger rows are written inside one transaction, so a
// failure at any step (not enough coins, a full stack) leaves everything
// as it was.
//
// requestId is the random id printed into the buy form. The same id sent
// twice (a double click, a retried request) returns the first purchase
// instead of making another; sent with different details it is refused.
export async function purchaseItem(pool, userId, { shopId, itemId, quantity, requestId }) {
  const shop = findShop(shopId);
  if (!shop) {
    throw new GameRuleError('There is no such shop.');
  }
  const offer = findEssential(shopId, itemId);
  if (!offer) {
    throw new GameRuleError(`${shop.name} does not sell that.`);
  }
  const maxQuantity = Math.min(offer.maxPerPurchase, MAX_PURCHASE_QUANTITY);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
    throw new GameRuleError(`You can buy between 1 and ${maxQuantity} ${offer.item.name} at a time.`);
  }
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(requestId)) {
    throw new GameRuleError('That purchase form was out of date. Please try again.');
  }

  const totalCost = offer.price * quantity;
  const requestHash = hashPurchase({ shopId: shop.id, itemId: offer.item.id, quantity, unitPrice: offer.price });

  return withTransaction(pool, async (db) => {
    // Locking the player's row makes this account's purchases run one at
    // a time, so a repeated request always sees the first one's result.
    if (!(await lockUser(db, userId))) {
      throw new Error(`No user ${userId}`);
    }

    const previous = await findPurchaseByKey(db, userId, requestId);
    if (previous) {
      if (previous.request_hash !== requestHash) {
        throw new GameRuleError('That purchase form was already used for something else.');
      }
      return describe(previous, shop, offer, { repeated: true, balance: null });
    }

    const purchase = await insertPurchase(db, {
      userId, shopId: shop.id, itemId: offer.item.id, quantity,
      unitPrice: offer.price, totalCost, idempotencyKey: requestId, requestHash,
    });
    const balance = await spendCoins(db, userId, totalCost, {
      reason: 'purchase', shopId: shop.id, itemId: offer.item.id, quantity, purchaseId: purchase.id,
    });
    await grantItem(db, userId, offer.item.id, quantity);
    return describe(purchase, shop, offer, { repeated: false, balance });
  });
}

function describe(purchase, shop, offer, { repeated, balance }) {
  return {
    purchaseId: purchase.id,
    shop,
    item: offer.item,
    quantity: purchase.quantity,
    unitPrice: purchase.unit_price,
    totalCost: purchase.total_cost,
    balance,
    repeated,
  };
}

function hashPurchase(details) {
  return crypto.createHash('sha256').update(JSON.stringify(details)).digest('hex');
}
