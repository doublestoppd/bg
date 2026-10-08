import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../helpers/test-database.js';
import { registerAccount } from '../../src/game/accounts.js';
import { adoptPet, listPets, getPet, MAX_PETS_PER_PLAYER, STARTING_STATS } from '../../src/game/pets.js';
import { GameRuleError } from '../../src/game/errors.js';

async function playerDb() {
  const db = openTestDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  return { db, user };
}

test('adopting creates a pet with starting stats and tidy name', async () => {
  const { db, user } = await playerDb();
  const pet = adoptPet(db, user.id, { name: '  Sir   Wobble ', species: 'wompus' });
  assert.equal(pet.name, 'Sir Wobble');
  assert.equal(pet.species, 'wompus');
  assert.equal(pet.hunger, STARTING_STATS.hunger);
  assert.equal(pet.health, STARTING_STATS.health);
});

test('bad names and unknown species are rejected', async () => {
  const { db, user } = await playerDb();
  assert.throws(() => adoptPet(db, user.id, { name: 'A', species: 'wompus' }), GameRuleError);
  assert.throws(() => adoptPet(db, user.id, { name: 'Bad<name>', species: 'wompus' }), GameRuleError);
  assert.throws(() => adoptPet(db, user.id, { name: 'Fine', species: 'dragon' }), GameRuleError);
  assert.equal(listPets(db, user.id).length, 0);
});

test('a player cannot exceed the pet limit', async () => {
  const { db, user } = await playerDb();
  for (let i = 0; i < MAX_PETS_PER_PLAYER; i++) {
    adoptPet(db, user.id, { name: `Pet ${i}`, species: 'gloop' });
  }
  assert.throws(() => adoptPet(db, user.id, { name: 'One Too Many', species: 'gloop' }), /at most/);
  assert.equal(listPets(db, user.id).length, MAX_PETS_PER_PLAYER);
});

test('players can only see their own pets', async () => {
  const { db, user } = await playerDb();
  const other = await registerAccount(db, { username: 'nosy', password: 'correct horse' });
  const pet = adoptPet(db, user.id, { name: 'Private', species: 'snibble' });
  assert.equal(getPet(db, user.id, pet.id).name, 'Private');
  assert.equal(getPet(db, other.id, pet.id), null);
  assert.equal(getPet(db, user.id, 'not-a-number'), null);
});
