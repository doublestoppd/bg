import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../helpers/test-database.js';
import { registerAccount } from '../../src/game/accounts.js';
import { grantItem, countOwned } from '../../src/game/inventory.js';
import { adoptPet, feedPet, getPet, STAT_MAX } from '../../src/game/pets.js';
import { GameRuleError } from '../../src/game/errors.js';

async function setup() {
  const db = openTestDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const pet = adoptPet(db, user.id, { name: 'Pebbles', species: 'snibble' });
  return { db, user, pet };
}

test('feeding consumes one item and raises the stats', async () => {
  const { db, user, pet } = await setup();
  const biscuits = countOwned(db, user.id, 'soggy-biscuit');

  const result = feedPet(db, user.id, { petId: pet.id, itemId: 'soggy-biscuit' });

  assert.equal(result.before.hunger, 60);
  assert.equal(result.pet.hunger, 75);
  assert.equal(countOwned(db, user.id, 'soggy-biscuit'), biscuits - 1);
  assert.equal(getPet(db, user.id, pet.id).hunger, 75, 'the change was saved');
});

test('stats never exceed the maximum', async () => {
  const { db, user, pet } = await setup();
  grantItem(db, user.id, 'pickled-moonbeam', 3);
  feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }); // hunger 60 -> 100
  const fed = getPet(db, user.id, pet.id);
  assert.equal(fed.hunger, STAT_MAX);
  assert.equal(fed.health, STAT_MAX, 'health was already full and stays capped');
  assert.equal(fed.happiness, 75);
});

test('a full pet refuses food and nothing is consumed', async () => {
  const { db, user, pet } = await setup();
  grantItem(db, user.id, 'pickled-moonbeam', 2);
  feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' });
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }), /too full/);
  assert.equal(countOwned(db, user.id, 'pickled-moonbeam'), 1);
});

test('only food can be eaten', async () => {
  const { db, user, pet } = await setup();
  grantItem(db, user.id, 'unlabelled-jar', 1);
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'unlabelled-jar' }), /not something a pet can eat/);
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'no-such-item' }), GameRuleError);
  assert.equal(countOwned(db, user.id, 'unlabelled-jar'), 1);
});

test('feeding requires owning the item', async () => {
  const { db, user, pet } = await setup();
  assert.equal(countOwned(db, user.id, 'pickled-moonbeam'), 0);
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }), /not have enough/);
  assert.equal(getPet(db, user.id, pet.id).hunger, 60);
});

test("feeding another player's pet is refused and consumes nothing", async () => {
  const { db, user, pet } = await setup();
  const other = await registerAccount(db, { username: 'nosy', password: 'correct horse' });
  const biscuits = countOwned(db, other.id, 'soggy-biscuit');
  assert.throws(() => feedPet(db, other.id, { petId: pet.id, itemId: 'soggy-biscuit' }), /not yours/);
  assert.equal(countOwned(db, other.id, 'soggy-biscuit'), biscuits);
  assert.equal(getPet(db, user.id, pet.id).hunger, 60);
});

test('a failure after the item is taken rolls the item back', async () => {
  const { db, user, pet } = await setup();
  const biscuits = countOwned(db, user.id, 'soggy-biscuit');

  // Simulate the stat update failing partway through the transaction.
  db.exec("CREATE TRIGGER fail_feed BEFORE UPDATE ON pets BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'soggy-biscuit' }), /simulated failure/);
  db.exec('DROP TRIGGER fail_feed');

  assert.equal(countOwned(db, user.id, 'soggy-biscuit'), biscuits, 'the biscuit came back');
  assert.equal(getPet(db, user.id, pet.id).hunger, 60);
});

test('repeating a feed cannot consume more than the player owns', async () => {
  const { db, user, pet } = await setup();
  grantItem(db, user.id, 'fizzing-pebble', 1);
  feedPet(db, user.id, { petId: pet.id, itemId: 'fizzing-pebble' });
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'fizzing-pebble' }), /not have enough/);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), 0);
  assert.equal(getPet(db, user.id, pet.id).happiness, 80, 'fed exactly once');
});
