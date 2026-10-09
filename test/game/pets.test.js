import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, databaseWithPlayer } from '../helpers/test-database.js';
import { registerAccount } from '../../src/game/accounts.js';
import { adoptPet, listPets, getPet, MAX_PETS_PER_PLAYER, STARTING_STATS } from '../../src/game/pets.js';
import { GameRuleError } from '../../src/game/errors.js';


test('adopting creates a pet with starting stats and tidy name', async () => {
  const { db, user } = await databaseWithPlayer();
  const pet = await adoptPet(db, user.id, { name: '  Sir   Wobble ', species: 'wompus' });
  assert.equal(pet.name, 'Sir Wobble');
  assert.equal(pet.species, 'wompus');
  assert.equal(pet.hunger, STARTING_STATS.hunger);
  assert.equal(pet.health, STARTING_STATS.health);
});

test('bad names and unknown species are rejected', async () => {
  const { db, user } = await databaseWithPlayer();
  await assert.rejects(adoptPet(db, user.id, { name: 'A', species: 'wompus' }), GameRuleError);
  await assert.rejects(adoptPet(db, user.id, { name: 'Bad<name>', species: 'wompus' }), GameRuleError);
  await assert.rejects(adoptPet(db, user.id, { name: 'Fine', species: 'dragon' }), GameRuleError);
  assert.equal((await listPets(db, user.id)).length, 0);
});

test('a player cannot exceed the pet limit, even with simultaneous requests', async () => {
  const { db, user } = await databaseWithPlayer();
  for (let i = 0; i < MAX_PETS_PER_PLAYER - 1; i++) {
    await adoptPet(db, user.id, { name: `Pet ${i}`, species: 'gloop' });
  }
  const results = await Promise.allSettled([
    adoptPet(db, user.id, { name: 'Last One', species: 'gloop' }),
    adoptPet(db, user.id, { name: 'One Too Many', species: 'gloop' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await listPets(db, user.id)).length, MAX_PETS_PER_PLAYER);
});

test('players can only see their own pets', async () => {
  const { db, user } = await databaseWithPlayer();
  const other = await registerAccount(db, { username: 'nosy', password: 'correct horse' });
  const pet = await adoptPet(db, user.id, { name: 'Private', species: 'snibble' });
  assert.equal((await getPet(db, user.id, pet.id)).name, 'Private');
  assert.equal(await getPet(db, other.id, pet.id), null);
  assert.equal(await getPet(db, user.id, 'not-a-number'), null);
});

test('the database refuses stats outside 0 to 100', async () => {
  const { db, user } = await databaseWithPlayer();
  const pet = await adoptPet(db, user.id, { name: 'Pebbles', species: 'snibble' });
  await assert.rejects(db.query('UPDATE pets SET hunger = 101 WHERE id = $1', [pet.id]), /check/i);
  await assert.rejects(db.query('UPDATE pets SET health = -1 WHERE id = $1', [pet.id]), /check/i);
});
