import { Router } from 'express';
import { requireLogin } from '../middleware/require-login.js';
import { GameRuleError } from '../game/errors.js';
import { allSpecies } from '../game/species.js';
import { adoptPet, listPets, getPet, MAX_PETS_PER_PLAYER } from '../game/pets.js';
import { STAT_NAMES, STAT_LABELS } from '../game/stats.js';

const router = Router();

router.use(requireLogin);

router.get('/', async (req, res) => {
  const pets = await listPets(req.app.locals.db, req.currentUser.id);
  res.render('pets/index', { title: 'My Pets', pets, maxPets: MAX_PETS_PER_PLAYER });
});

router.get('/adopt', (req, res) => {
  res.render('pets/adopt', { title: 'Adopt a Pet', species: allSpecies(), error: null, name: '', chosen: '' });
});

router.post('/adopt', async (req, res, next) => {
  try {
    const pet = await adoptPet(req.app.locals.db, req.currentUser.id, {
      name: req.body.name,
      species: req.body.species,
    });
    res.redirect(`/pets/${pet.id}?adopted=1`);
  } catch (error) {
    if (error instanceof GameRuleError) {
      return res.status(400).render('pets/adopt', {
        title: 'Adopt a Pet',
        species: allSpecies(),
        error: error.message,
        name: req.body.name || '',
        chosen: req.body.species || '',
      });
    }
    next(error);
  }
});

router.get('/:id', async (req, res) => {
  const pet = await getPet(req.app.locals.db, req.currentUser.id, req.params.id);
  if (!pet) {
    return res.status(404).render('error', {
      title: 'Pet not found',
      message: 'No pet of yours lives at that address.',
    });
  }
  res.render('pets/show', { title: pet.name, pet, statNames: STAT_NAMES, statLabels: STAT_LABELS, justAdopted: req.query.adopted === '1' });
});

export default router;
