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

router.post('/:id/buy', (req, res, next) => {
  const shop = findShop(req.params.id);
  if (!shop) return shopNotFound(res);

  // Each rendering of the shop page carries a one-time purchase token.
  // Spending it here means a double-click or a resubmitted form cannot
  // buy twice: the second submission arrives with a token already used.
  if (!req.body.purchase_token || req.body.purchase_token !== req.session.purchaseToken) {
    return renderShop(req, res, shop, { status: 400, error: 'That purchase was already made, or the page was out of date. Please try again.' });
  }
  delete req.session.purchaseToken;

  try {
    // Only the item id and quantity come from the form. The price is
    // looked up in the shop catalog inside purchaseItem.
    const result = purchaseItem(req.app.locals.db, req.currentUser.id, {
      shopId: shop.id,
      itemId: req.body.item,
      quantity: Number(req.body.quantity),
    });
    req.session.flash = {
      type: 'success',
      text: `You bought ${result.quantity} ${result.item.name} for ${result.totalCost} coins. You have ${result.balance} coins left.`,
    };
    res.redirect(`/shops/${shop.id}`);
  } catch (error) {
    if (error instanceof GameRuleError) {
      return renderShop(req, res, shop, { status: 400, error: error.message });
    }
    next(error);
  }
});

function renderShop(req, res, shop, { status, error }) {
  req.session.purchaseToken = crypto.randomBytes(16).toString('hex');
  res.status(status).render('shops/show', {
    title: shop.name,
    shop,
    merchandise: shop.merchandise.map((offer) => ({ ...offer, item: findItem(offer.itemId) })),
    purchaseToken: req.session.purchaseToken,
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
