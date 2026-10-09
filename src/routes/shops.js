import crypto from 'node:crypto';
import { Router } from 'express';
import { requireLogin } from '../middleware/require-login.js';
import { createRateLimiter, windowStartFor } from '../middleware/rate-limit.js';
import { GameRuleError } from '../game/errors.js';
import { allShops, findShop } from '../game/shops.js';
import { purchaseItem } from '../game/purchases.js';
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

// Current remaining quantities, for the optional refresh script in
// public/js/shop.js. Same view limits as the page. Deliberately says
// nothing about when the next restock is.
router.get('/:id/stock.json', viewLimits, async (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return res.status(404).json({ error: 'no such shop' });
  try {
    const merchandise = await shopMerchandise(req.app.locals.db, shop.id);
    res.json({
      restockId: merchandise.currentRestockId,
      paused: merchandise.paused,
      listings: merchandise.listings.map((l) => ({ id: l.id, remaining: l.remaining_quantity })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/buy', purchaseLimit, async (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);
  const db = req.app.locals.db;
  const userId = req.currentUser.id;
  const listingId = Number.isSafeInteger(Number(req.body.listing)) ? Number(req.body.listing) : null;

  // Too many refused purchases lately pauses buying for the rest of the
  // window. A person who clicks a sold-out item twice never notices; a
  // script hammering the shelves does.
  const failedWindow = windowStartFor(FAILED_WINDOW_MS);
  if ((await readCounter(db, 'purchase-failed:user', String(userId), failedWindow)) >= SHOP_LIMITS.failedPurchasesPerFiveMinutes) {
    await logLimited('purchase-failed:user')(req);
    return renderShop(req, res, shop, { status: 429, error: 'Too many purchases have failed in the last few minutes. Please wait a little and try again.' }).catch(next);
  }

  try {
    // Only the listing id, the quantity, the price the player saw and the
    // form's request id come from the browser. The real price is read from
    // the listing inside purchaseItem, and the request id makes a
    // resubmitted form harmless.
    const result = await purchaseItem(db, userId, {
      shopId: shop.id,
      listingId: req.body.listing,
      quantity: wholeNumber(req.body.quantity),
      shownPrice: wholeNumber(req.body.shown_price),
      requestId: req.body.request_id,
    });
    req.session.flash = { type: 'success', text: purchaseMessage(result) };
    res.redirect(`/shops/${shop.id}`);
  } catch (error) {
    if (error instanceof GameRuleError) {
      await incrementCounter(db, 'purchase-failed:user', String(userId), failedWindow);
      await logShopActivity(db, {
        userId, ip: req.ip, kind: refusalKind(error), shopId: shop.id, stockId: listingId,
        details: { message: error.message, quantity: req.body.quantity },
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
    listings: merchandise.listings.map((listing) => ({ ...listing, requestId: crypto.randomUUID() })),
    paused: merchandise.paused,
    restockMessage: restockMessage(shop, merchandise),
    currentRestockId: merchandise.currentRestockId,
    error,
  });
}

// What the shop says about its shelves. Never the next restock time.
function restockMessage(shop, merchandise) {
  if (merchandise.paused) return `The shutters are down. ${shop.keeper.name} is not restocking at the moment.`;
  if (!merchandise.lastRestockAt) return `${shop.keeper.name} is still unpacking the first delivery.`;
  return `${shop.keeper.name} last restocked the shelves ${timeAgo(merchandise.lastRestockAt)}. New stock arrives whenever it arrives.`;
}

function timeAgo(date) {
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (minutes < 1) return 'moments ago';
  if (minutes === 1) return 'a minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 120) return 'about an hour ago';
  return `${Math.floor(minutes / 60)} hours ago`;
}

// A form field that must be a plain whole number. Number() would also
// accept "0x3", "1e2" or " 3 "; those are never what a real form sends.
function wholeNumber(value) {
  return typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
}

function purchaseMessage(result) {
  if (result.repeated) {
    return `That purchase of ${result.quantity} ${result.item.name} had already gone through.`;
  }
  const shelf = result.remaining === 0 ? ' That was the last of them.' : ` ${result.remaining} left on the shelf.`;
  return `You bought ${result.quantity} ${result.item.name} for ${result.totalCost} coins. You have ${result.balance} coins left.${shelf}`;
}

function shopNotFound(res) {
  res.status(404).render('error', {
    title: 'Shop not found',
    message: 'That shop is not on any map of the garden.',
  });
}

export default router;
