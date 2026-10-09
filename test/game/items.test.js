import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from '../helpers/test-database.js';
import { allItems, findItem, syncItemCatalog, CATEGORIES } from '../../src/game/items.js';
import { allItemRows, findItemRow } from '../../src/db/items.js';
import { registerAccount } from '../../src/game/accounts.js';
import { countOwned, listInventory, grantItem, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { addToStack } from '../../src/db/inventory.js';
import { adoptPet, feedPet } from '../../src/game/pets.js';

test('the catalog has unique slugs and valid categories, and no item carries a rarity', () => {
  const ids = allItems().map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of allItems()) {
    assert.ok(CATEGORIES.includes(item.category), item.id);
    assert.equal('rarity' in item, false, `${item.id} must not carry a rarity; scarcity comes from distribution`);
  }
  assert.equal(findItem('soggy-biscuit').category, 'food');
  assert.equal(findItem('no-such-thing'), null);
});

test('syncing loads the catalog and is idempotent', async () => {
  const db = await resetDatabase();
  await syncItemCatalog(db);
  assert.equal((await allItemRows(db)).length, allItems().length);
  const row = await findItemRow(db, 'humming-turnip');
  assert.equal(row.name, 'Humming Turnip');
  assert.equal('rarity' in row, false, 'the items table has no rarity column');
  assert.deepEqual(row.effects, { hunger: 25, happiness: 5 });
  assert.equal(row.retired, false);
  assert.equal(row.obtainable, true);
  assert.equal((await findItemRow(db, 'jubilee-crumpet')).obtainable, false);
});

test('syncing updates changed definitions in place', async () => {
  const db = await resetDatabase();
  const edited = allItems().map((item) => (item.id === 'soggy-biscuit' ? { ...item, name: 'Slightly Less Soggy Biscuit' } : item));
  await syncItemCatalog(db, edited);
  assert.equal((await findItemRow(db, 'soggy-biscuit')).name, 'Slightly Less Soggy Biscuit');
  await syncItemCatalog(db);
  assert.equal((await findItemRow(db, 'soggy-biscuit')).name, 'Soggy Biscuit');
});

test('an item dropped from the catalog is retired, not deleted, and players keep it', async () => {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const before = await countOwned(db, user.id, 'soggy-biscuit');
  assert.ok(before > 0, 'new players get biscuits');

  await syncItemCatalog(db, allItems().filter((item) => item.id !== 'soggy-biscuit'));
  assert.equal((await findItemRow(db, 'soggy-biscuit')).retired, true);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), before);
  const shown = (await listInventory(db, user.id)).find((row) => row.item_id === 'soggy-biscuit');
  assert.equal(shown.retired, true);

  await syncItemCatalog(db); // putting it back un-retires it
  assert.equal((await findItemRow(db, 'soggy-biscuit')).retired, false);
});

test('a limited-time item cannot be granted but can still be used', async () => {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const pet = await adoptPet(db, user.id, { name: 'Pebbles', species: 'gloop' });

  await assert.rejects(grantItem(db, user.id, 'jubilee-crumpet', 1), /no longer being handed out/);
  await addToStack(db, user.id, 'jubilee-crumpet', 1, MAX_STACK_SIZE); // received while it was obtainable
  const shown = (await listInventory(db, user.id)).find((row) => row.item_id === 'jubilee-crumpet');
  assert.equal(shown.obtainable, false);
  assert.equal(shown.usable, true);
  const result = await feedPet(db, user.id, { petId: pet.id, itemId: 'jubilee-crumpet' });
  assert.equal(result.pet.hunger, 90);
  assert.equal(await countOwned(db, user.id, 'jubilee-crumpet'), 0);
});

test('a retired item is kept but cannot be used', async () => {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const pet = await adoptPet(db, user.id, { name: 'Pebbles', species: 'gloop' });
  // What the sync leaves behind after an item is deleted from the catalog.
  await db.query(`
    INSERT INTO items (id, name, description, category, image, effects, obtainable, retired)
    VALUES ('old-biscuit', 'Old Biscuit', 'From a bygone era.', 'food', NULL, '{"hunger":10}', false, true)
  `);
  await addToStack(db, user.id, 'old-biscuit', 2, MAX_STACK_SIZE);
  await syncItemCatalog(db); // must leave the retired row and the stack alone

  const shown = (await listInventory(db, user.id)).find((row) => row.item_id === 'old-biscuit');
  assert.equal(shown.retired, true);
  assert.equal(shown.usable, false);
  await assert.rejects(feedPet(db, user.id, { petId: pet.id, itemId: 'old-biscuit' }), /no longer part of the game/);
  await assert.rejects(grantItem(db, user.id, 'old-biscuit', 1), /does not exist/);
  assert.equal(await countOwned(db, user.id, 'old-biscuit'), 2);
});
