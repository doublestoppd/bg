import { Router } from 'express';
import { requireLogin } from '../middleware/require-login.js';
import { GameRuleError } from '../game/errors.js';
import { listInventory } from '../game/inventory.js';
import { listPets, feedPet } from '../game/pets.js';

const router = Router();

router.use(requireLogin);

router.get('/', (req, res) => {
  renderInventory(req, res, { status: 200, error: null });
});

router.post('/feed', (req, res, next) => {
  try {
    const result = feedPet(req.app.locals.db, req.currentUser.id, {
      petId: req.body.pet,
      itemId: req.body.item,
    });
    req.session.flash = {
      type: 'success',
      text: `${result.pet.name} ate the ${result.item.name}. ${describeChanges(result.before, result.pet)}`,
    };
    // Redirect after a successful POST so that refreshing the page does
    // not feed the pet again.
    res.redirect('/inventory');
  } catch (error) {
    if (error instanceof GameRuleError) {
      return renderInventory(req, res, { status: 400, error: error.message });
    }
    next(error);
  }
});

function renderInventory(req, res, { status, error }) {
  const db = req.app.locals.db;
  res.status(status).render('inventory/index', {
    title: 'Inventory',
    items: listInventory(db, req.currentUser.id),
    pets: listPets(db, req.currentUser.id),
    error,
  });
}

// "Hunger 60 to 75, Happiness 60 to 65."
function describeChanges(before, after) {
  const parts = [];
  for (const stat of ['hunger', 'happiness', 'health']) {
    if (before[stat] !== after[stat]) {
      parts.push(`${capitalise(stat)} ${before[stat]} to ${after[stat]}`);
    }
  }
  return parts.length ? parts.join(', ') + '.' : 'Nothing seemed to change.';
}

function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default router;
