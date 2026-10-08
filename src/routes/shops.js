import crypto from 'node:crypto';
import { Router } from 'express';
import { requireLogin } from '../middleware/require-login.js';
import { createRateLimiter, windowStartFor } from '../middleware/rate-limit.js';
import { GameRuleError } from '../game/errors.js';
import { allShops, findShop } from '../game/shops.js';
import { findItem } from '../game/items.js';
import { purchaseItem, MAX_PURCHASE_QUANTITY } from '../game/purchases.js';
import { shopMerchandise } from '../game/restocking.js';
import { SHOP_LIMITS } from '../game/shop-limits.js';
import { logShopActivity, refusalKind } from '../game/activity.js';
import { incrementCounter, readCounter } from '../db/request-counters.js';

const router = Router();
const MINUTE = 60 * 1000;
const FAILED_WINDOW_MS = 5 * MINUTE;

router.use(requireLogin);

// ----- Rate limits (counters live in PostgreSQL; see game/shop-limits.js) -----

const byAccount = (req) => req.currentUser.id;
const logLimited = (scope) => (req) => logShopActivity(req.app.locals.db, {
  userId: req.currentUser.id, ip: req.ip, kind: 'rate_limited', shopId: req.params.id || null, details: { scope },
});

// Browsing: generous, so refreshing a shop page by hand is never a problem.
const viewLimits = [
  createRateLimiter({ scope: 'shop-view:user', keyFrom: byAccount, maxAttempts: SHOP_LIMITS.shopViewsPerMinutePerAccount, windowMs: MINUTE, onLimited: logLimited('shop-view:user') }),
  createRateLimiter({ scope: 'shop-view:ip', maxAttempts: SHOP_LIMITS.shopViewsPerMinutePerIp, windowMs: MINUTE, onLimited: logLimited('shop-view:ip') }),
];
// Buying: counts every submission.
const purchaseLimit = createRateLimiter({ scope: 'purchase:user', keyFrom: byAccount, maxAttempts: SHOP_LIMITS.purchaseAttemptsPerMinutePerAccount, windowMs: MINUTE, onLimited: logLimited('purchase:user') });

// ----- Pages -----

router.get('/', viewLimits, (req, res) => {
  res.render('shops/index', { title: 'Shops', shops: allShops() });
});

router.get('/:id', viewLimits, async (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);
  renderShop(req, res, shop, { status: 200, error: null }).catch(next);
});

router.post('/:id/buy', purchaseLimit, async (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);
  const db = req.app.locals.db;
  const userId = req.currentUser.id;

  // Too many refused purchases lately pauses buying for the rest of the
  // window. A person who clicks a sold-out item twice never notices; a
  // script hammering the shelves does.
  const failedWindow = windowStartFor(FAILED_WINDOW_MS);
  if ((await readCounter(db, 'purchase-failed:user', String(userId), failedWindow)) >= SHOP_LIMITS.failedPurchasesPerFiveMinutes) {
    await logShopActivity(db, { userId, ip: req.ip, kind: 'rate_limited', shopId: shop.id, details: { scope: 'purchase-failed:user' } });
    return renderShop(req, res, shop, { status: 429, error: 'Too many purchases have failed in the last few minutes. Please wait a little and try again.' }).catch(next);
  }

  try {
    // Only ids, the quantity, the price the player saw and the form's
    // request id come from the browser. The real price is looked up inside
    // purchaseItem, and the request id makes a resubmitted form harmless.
    const result = await purchaseItem(db, userId, {
      shopId: shop.id,
      itemId: req.body.item,
      listingId: req.body.listing,
      quantity: Number(req.body.quantity),
      shownPrice: Number(req.body.shown_price),
      requestId: req.body.request_id,
    });
    if (!result.repeated && result.item.rarity === 'rare' && result.remaining !== null) {
      await logShopActivity(db, { userId, ip: req.ip, kind: 'rare_purchase', shopId: shop.id, stockId: Number(req.body.listing), details: { item: result.item.id, quantity: result.quantity, unitPrice: result.unitPrice } });
    }
    req.session.flash = { type: 'success', text: purchaseMessage(result) };
    res.redirect(`/shops/${shop.id}`);
  } catch (error) {
    if (error instanceof GameRuleError) {
      await incrementCounter(db, 'purchase-failed:user', String(userId), failedWindow);
      await logShopActivity(db, {
        userId, ip: req.ip, kind: refusalKind(error), shopId: shop.id,
        stockId: Number.isSafeInteger(Number(req.body.listing)) ? Number(req.body.listing) : null,
        details: { message: error.message, item: req.body.item || null, quantity: req.body.quantity },
      });
      return renderShop(req, res, shop, { status: 400, error: error.message }).catch(next);
    }
    next(error);
  }
});

async function renderShop(req, res, shop, { status, error }) {
  const merchandise = await shopMerchandise(req.app.locals.db, shop.id);
  res.status(status).render('shops/show', {
    title: shop.name,
    shop,
    keeperLine: shop.keeper.lines[Math.floor(Math.random() * shop.keeper.lines.length)],
    // Each buy form gets its own random request id (see purchaseItem).
    essentials: merchandise.essentials.map((offer) => ({
      ...offer,
      item: findItem(offer.itemId),
      maxQuantity: Math.min(offer.maxPerPurchase, MAX_PURCHASE_QUANTITY),
      requestId: crypto.randomUUID(),
    })),
    listings: merchandise.listings.map((listing) => ({
      ...listing,
      maxQuantity: Math.min(listing.max_per_purchase, listing.remaining_quantity, MAX_PURCHASE_QUANTITY),
      requestId: crypto.randomUUID(),
    })),
    paused: merchandise.paused,
    error,
  });
}

function purchaseMessage(result) {
  if (result.repeated) {
    return `That purchase of ${result.quantity} ${result.item.name} had already gone through.`;
  }
  const shelf = result.remaining === null ? '' : result.remaining === 0 ? ' That was the last of them.' : ` ${result.remaining} left on the shelf.`;
  return `You bought ${result.quantity} ${result.item.name} for ${result.totalCost} coins. You have ${result.balance} coins left.${shelf}`;
}

function shopNotFound(res) {
  res.status(404).render('error', {
    title: 'Shop not found',
    message: 'That shop is not on any map of the garden.',
  });
}

export default router;
