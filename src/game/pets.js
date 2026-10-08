import { GameRuleError } from './errors.js';
import { findSpecies } from './species.js';
import { countPetsByOwner, findPetForOwner, findPetsByOwner, insertPet } from '../db/pets.js';

// ----- Tunable rules -----
export const MAX_PETS_PER_PLAYER = 4;
export const PET_NAME_MIN_LENGTH = 2;
export const PET_NAME_MAX_LENGTH = 20;
export const STARTING_STATS = { hunger: 60, happiness: 60, health: 100 };

// Letters, numbers, spaces, apostrophes and hyphens. Collapsed to single
// spaces before checking, so "Sir   Wobble" becomes "Sir Wobble".
const PET_NAME_PATTERN = /^[A-Za-z0-9' -]+$/;

// Gives the player a new pet. Returns the pet row.
export function adoptPet(db, userId, { name, species }) {
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

  // Counting and inserting happen together so two quick submissions cannot
  // both slip under the limit.
  return db.transaction(() => {
    if (countPetsByOwner(db, userId) >= MAX_PETS_PER_PLAYER) {
      throw new GameRuleError(`You can look after at most ${MAX_PETS_PER_PLAYER} pets at once.`);
    }
    return insertPet(db, { userId, name: cleanName, species, ...STARTING_STATS });
  })();
}

export function listPets(db, userId) {
  return findPetsByOwner(db, userId).map(withSpecies);
}

// Returns the pet, or null if it does not exist or belongs to someone else.
export function getPet(db, userId, petId) {
  const pet = findPetForOwner(db, Number(petId), userId);
  return pet ? withSpecies(pet) : null;
}

// Attaches the species design data (name, description, image) to a pet row.
function withSpecies(pet) {
  return { ...pet, speciesInfo: findSpecies(pet.species) };
}
