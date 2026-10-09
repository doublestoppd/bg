import { GameRuleError } from './errors.js';
import { findSpecies } from './species.js';
import { findItem } from './items.js';
import { takeItem } from './inventory.js';
import { withTransaction } from '../db/pool.js';
import { countPetsByOwner, findPetForOwner, findPetsByOwner, insertPet, updatePetStats } from '../db/pets.js';
import { lockUser } from '../db/users.js';
import { STAT_NAMES } from './stats.js';

// ----- Tunable rules -----
export const MAX_PETS_PER_PLAYER = 4;
export const PET_NAME_MIN_LENGTH = 2;
export const PET_NAME_MAX_LENGTH = 20;
export const STARTING_STATS = { hunger: 60, happiness: 60, health: 100 };
export const STAT_MIN = 0;
export const STAT_MAX = 100;

// Letters, numbers, spaces, apostrophes and hyphens. Collapsed to single
// spaces before checking, so "Sir   Wobble" becomes "Sir Wobble".
const PET_NAME_PATTERN = /^[A-Za-z0-9' -]+$/;

// Gives the player a new pet. Returns the pet row.
export async function adoptPet(pool, userId, { name, species }) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ');

  if (cleanName.length < PET_NAME_MIN_LENGTH || cleanName.length > PET_NAME_MAX_LENGTH) {
    throw new GameRuleError(`Pet names must be between ${PET_NAME_MIN_LENGTH} and ${PET_NAME_MAX_LENGTH} characters.`);
  }
  if (!PET_NAME_PATTERN.test(cleanName)) {
    throw new GameRuleError('Pet names may only contain letters, numbers, spaces, apostrophes and hyphens.');
  }
  if (!findSpecies(species)) {
    throw new GameRuleError('Please choose one of the available species.');
  }

  // Counting and inserting happen in one transaction with the player's
  // row locked, so two quick submissions cannot both slip under the limit.
  return withTransaction(pool, async (db) => {
    await lockUser(db, userId);
    if ((await countPetsByOwner(db, userId)) >= MAX_PETS_PER_PLAYER) {
      throw new GameRuleError(`You can look after at most ${MAX_PETS_PER_PLAYER} pets at once.`);
    }
    return insertPet(db, { userId, name: cleanName, species, ...STARTING_STATS });
  });
}

export async function listPets(db, userId) {
  return (await findPetsByOwner(db, userId)).map(withSpecies);
}

// Returns the pet, or null if it does not exist or belongs to someone else.
// A non-numeric id is simply "not found".
export async function getPet(db, userId, petId) {
  const id = Number(petId);
  if (!Number.isSafeInteger(id)) return null;
  const pet = await findPetForOwner(db, id, userId);
  return pet ? withSpecies(pet) : null;
}

// Attaches the species design data (name, description, image) to a pet row.
function withSpecies(pet) {
  return { ...pet, speciesInfo: findSpecies(pet.species) };
}

// Feeds one unit of a food item to the player's pet. The item leaves the
// inventory and the pet's stats change inside one transaction, so a
// failure at any step leaves both untouched.
export async function feedPet(pool, userId, { petId, itemId }) {
  const item = findItem(itemId);
  if (!item) {
    throw new GameRuleError('That item is no longer part of the game and cannot be used.');
  }
  if (item.category !== 'food') {
    throw new GameRuleError('That is not something a pet can eat.');
  }
  const id = Number(petId);
  if (!Number.isSafeInteger(id)) {
    throw new GameRuleError('That pet is not yours to feed.');
  }

  return withTransaction(pool, async (db) => {
    const pet = await findPetForOwner(db, id, userId);
    if (!pet) {
      throw new GameRuleError('That pet is not yours to feed.');
    }

    const newStats = applyEffects(pet, item.effects);
    // A pet refuses food only when eating it would change nothing: every
    // stat the food affects is already at its cap. That way no item is
    // wasted on a no-op, and a treat that mostly raises happiness still
    // works on a pet whose hunger is full.
    if (STAT_NAMES.every((stat) => newStats[stat] === pet[stat])) {
      throw new GameRuleError(`${pet.name} is too full for that to make any difference.`);
    }

    await takeItem(db, userId, item.id, 1); // throws if the player has none

    if (!(await updatePetStats(db, pet.id, userId, newStats))) {
      throw new Error(`Pet ${pet.id} could not be updated while feeding`);
    }

    return { pet: withSpecies({ ...pet, ...newStats }), before: pickStats(pet), item };
  });
}

// Adds each effect to the matching stat and keeps every stat within
// STAT_MIN..STAT_MAX.
function applyEffects(pet, effects) {
  const stats = pickStats(pet);
  for (const [stat, amount] of Object.entries(effects)) {
    stats[stat] = Math.max(STAT_MIN, Math.min(STAT_MAX, stats[stat] + amount));
  }
  return stats;
}

function pickStats(pet) {
  const stats = {};
  for (const stat of STAT_NAMES) stats[stat] = pet[stat];
  return stats;
}
