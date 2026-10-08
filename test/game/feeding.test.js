import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from '../helpers/test-database.js';
import { registerAccount } from '../../src/game/accounts.js';
import { grantItem, countOwned } from '../../src/game/inventory.js';
import { adoptPet, feedPet, getPet, STAT_MAX } from '../../src/game/pets.js';
import { GameRuleError } from '../../src/game/errors.js';

async function setup() {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const pet = await adoptPet(db, user.id, { name: 'Pebbles', species: 'snibble' });
  return { db, user, pet };
}

test('feeding consumes one item and raises the stats', async () => {
  const { db, user, pet } = await setup();
  const biscuits = await countOwned(db, user.id, 'soggy-biscuit');

  const result = await feedPet(db, user.id, { petId: pet.id, itemId: 'soggy-biscuit' });

  assert.equal(result.before.hunger, 60);
  assert.equal(result.pet.hunger, 75);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), biscuits - 1);
  assert.equal((await getPet(db, user.id, pet.id)).hunger, 75, 'the change was saved');
});

test('stats never exceed the maximum', async () => {
  const { db, user, pet } = await setup();
  await grantItem(db, user.id, 'pickled-moonbeam', 3);
  await feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }); // hunger 60 -> 100
  const fed = await getPet(db, user.id, pet.id);
  assert.equal(fed.hunger, STAT_MAX);
  assert.equal(fed.health, STAT_MAX, 'health was already full and stays capped');
  assert.equal(fed.happiness, 75);
});

test('food is refused only when it would change nothing', async () => {
  const { db, user, pet } = await setup();
  await grantItem(db, user.id, 'pickled-moonbeam', 3);
  await grantItem(db, user.id, 'fizzing-pebble', 2);
  await feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }); // hunger 100, happiness 75

  // Hunger is full, but a pebble still raises happiness, so it is eaten.
  const pebble = await feedPet(db, user.id, { petId: pet.id, itemId: 'fizzing-pebble' });
  assert.equal(pebble.pet.hunger, 100);
  assert.equal(pebble.pet.happiness, 95);
  await feedPet(db, user.id, { petId: pet.id, itemId: 'fizzing-pebble' }); // happiness 100

  // Now every stat a moonbeam touches is at its cap: refused, nothing consumed.
  await assert.rejects(feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }), /make any difference/);
  assert.equal(await countOwned(db, user.id, 'pickled-moonbeam'), 2);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 0);
});

test('only food can be eaten', async () => {
  const { db, user, pet } = await setup();
  await grantItem(db, user.id, 'unlabelled-jar', 1);
  await assert.rejects(feedPet(db, user.id, { petId: pet.id, itemId: 'unlabelled-jar' }), /not something a pet can eat/);
  await assert.rejects(feedPet(db, user.id, { petId: pet.id, itemId: 'no-such-item' }), GameRuleError);
  assert.equal(await countOwned(db, user.id, 'unlabelled-jar'), 1);
});

test('feeding requires owning the item', async () => {
  const { db, user, pet } = await setup();
  assert.equal(await countOwned(db, user.id, 'pickled-moonbeam'), 0);
  await assert.rejects(feedPet(db, user.id, { petId: pet.id, itemId: 'pickled-moonbeam' }), /not have enough/);
  assert.equal((await getPet(db, user.id, pet.id)).hunger, 60);
});

test("feeding another player's pet is refused and consumes nothing", async () => {
  const { db, user, pet } = await setup();
  const other = await registerAccount(db, { username: 'nosy', password: 'correct horse' });
  const biscuits = await countOwned(db, other.id, 'soggy-biscuit');
  await assert.rejects(feedPet(db, other.id, { petId: pet.id, itemId: 'soggy-biscuit' }), /not yours/);
  await assert.rejects(feedPet(db, other.id, { petId: 'abc', itemId: 'soggy-biscuit' }), /not yours/);
  assert.equal(await countOwned(db, other.id, 'soggy-biscuit'), biscuits);
  assert.equal((await getPet(db, user.id, pet.id)).hunger, 60);
});

test('a failure after the item is taken rolls the item back', async () => {
  const { db, user, pet } = await setup();
  const biscuits = await countOwned(db, user.id, 'soggy-biscuit');

  // Simulate the stat update failing partway through the transaction.
  await db.query(`
    CREATE FUNCTION fail_feed() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_feed BEFORE UPDATE ON pets FOR EACH ROW EXECUTE FUNCTION fail_feed();
  `);
  await assert.rejects(feedPet(db, user.id, { petId: pet.id, itemId: 'soggy-biscuit' }), /simulated failure/);
  await db.query('DROP TRIGGER fail_feed ON pets; DROP FUNCTION fail_feed();');

  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), biscuits, 'the biscuit came back');
  assert.equal((await getPet(db, user.id, pet.id)).hunger, 60);
});

test('simultaneous feeds cannot consume more than the player owns', async () => {
  const { db, user, pet } = await setup();
  await grantItem(db, user.id, 'fizzing-pebble', 1);
  const results = await Promise.allSettled([
    feedPet(db, user.id, { petId: pet.id, itemId: 'fizzing-pebble' }),
    feedPet(db, user.id, { petId: pet.id, itemId: 'fizzing-pebble' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 0);
  assert.equal((await getPet(db, user.id, pet.id)).happiness, 80, 'fed exactly once');
});
