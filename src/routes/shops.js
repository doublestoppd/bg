import crypto from 'node:crypto';
import { Router } from 'express';
import { requireLogin } from '../middleware/require-login.js';
import { GameRuleError } from '../game/errors.js';
import { allShops, findShop } from '../game/shops.js';
import { findItem } from '../game/items.js';
import { purchaseItem, MAX_PURCHASE_QUANTITY } from '../game/purchases.js';

const router = Router();

router.use(requireLogin);

router.get('/', (req, res) => {
  res.render('shops/index', { title: 'Shops', shops: allShops() });
});

router.get('/:id', (req, res) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);
  renderShop(req, res, shop, { status: 200, error: null });
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
      quantity: Number(req.body.quantity),
      requestId: req.body.request_id,
    });
    req.session.flash = result.repeated
      ? { type: 'success', text: `That purchase of ${result.quantity} ${result.item.name} had already gone through.` }
      : { type: 'success', text: `You bought ${result.quantity} ${result.item.name} for ${result.totalCost} coins. You have ${result.balance} coins left.` };
    res.redirect(`/shops/${shop.id}`);
  } catch (error) {
    if (error instanceof GameRuleError) {
      return renderShop(req, res, shop, { status: 400, error: error.message });
    }
    next(error);
  }
});

function renderShop(req, res, shop, { status, error }) {
  res.status(status).render('shops/show', {
    title: shop.name,
    shop,
    // Each buy form gets its own random request id (see purchaseItem).
    merchandise: shop.merchandise.map((offer) => ({ ...offer, item: findItem(offer.itemId), requestId: crypto.randomUUID() })),
    maxQuantity: MAX_PURCHASE_QUANTITY,
    error,
  });
}

function shopNotFound(res) {
  res.status(404).render('error', {
    title: 'Shop not found',
    message: 'That shop is not on any map of the garden.',
  });
}

export default router;
