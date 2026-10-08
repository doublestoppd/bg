import crypto from 'node:crypto';
import { Router } from 'express';
import { requireLogin } from '../middleware/require-login.js';
import { GameRuleError } from '../game/errors.js';
import { allShops, findShop } from '../game/shops.js';
import { findItem } from '../game/items.js';
import { purchaseItem, MAX_PURCHASE_QUANTITY } from '../game/purchases.js';
import { shopMerchandise } from '../game/restocking.js';

const router = Router();

router.use(requireLogin);

router.get('/', (req, res) => {
  res.render('shops/index', { title: 'Shops', shops: allShops() });
});

router.get('/:id', async (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);
  renderShop(req, res, shop, { status: 200, error: null }).catch(next);
});

router.post('/:id/buy', async (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);

  try {
    // Only the item id, quantity and the form's request id come from the
    // browser. The price is looked up in the shop catalog inside
    // purchaseItem, and the request id makes a resubmitted form harmless.
    const result = await purchaseItem(req.app.locals.db, req.currentUser.id, {
      shopId: shop.id,
      itemId: req.body.item,
      listingId: req.body.listing,
      quantity: Number(req.body.quantity),
      shownPrice: Number(req.body.shown_price),
      requestId: req.body.request_id,
    });
    req.session.flash = { type: 'success', text: purchaseMessage(result) };
    res.redirect(`/shops/${shop.id}`);
  } catch (error) {
    if (error instanceof GameRuleError) {
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
