import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/connection.js';
import { allItems, findItem, syncItemCatalog, CATEGORIES, RARITIES } from '../../src/game/items.js';
import { allItemRows, findItemRow } from '../../src/db/items.js';
import { registerAccount } from '../../src/game/accounts.js';
import { countOwned, listInventory, grantItem, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { addToStack } from '../../src/db/inventory.js';
import { adoptPet, feedPet } from '../../src/game/pets.js';

test('the catalog has unique slugs and valid categories and rarities', () => {
  const ids = allItems().map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of allItems()) {
    assert.ok(CATEGORIES.includes(item.category), item.id);
    assert.ok(RARITIES.includes(item.rarity), item.id);
  }
  assert.equal(findItem('soggy-biscuit').category, 'food');
  assert.equal(findItem('no-such-thing'), null);
});

test('syncing loads the catalog and is idempotent', () => {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  syncItemCatalog(db);
  assert.equal(allItemRows(db).length, allItems().length);
  const row = findItemRow(db, 'humming-turnip');
  assert.equal(row.name, 'Humming Turnip');
  assert.deepEqual(JSON.parse(row.effects), { hunger: 25, happiness: 5 });
  assert.equal(row.retired, 0);
});

test('syncing updates changed definitions in place', () => {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  const edited = allItems().map((item) => (item.id === 'soggy-biscuit' ? { ...item, name: 'Slightly Less Soggy Biscuit' } : item));
  syncItemCatalog(db, edited);
  assert.equal(findItemRow(db, 'soggy-biscuit').name, 'Slightly Less Soggy Biscuit');
});

test('an item dropped from the catalog is retired, not deleted, and players keep it', async () => {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const before = countOwned(db, user.id, 'soggy-biscuit');
  assert.ok(before > 0, 'new players get biscuits');

  const withoutBiscuit = allItems().filter((item) => item.id !== 'soggy-biscuit');
  syncItemCatalog(db, withoutBiscuit);

  assert.equal(findItemRow(db, 'soggy-biscuit').retired, 1);
  assert.equal(countOwned(db, user.id, 'soggy-biscuit'), before);
  const shown = listInventory(db, user.id).find((row) => row.item_id === 'soggy-biscuit');
  assert.equal(shown.retired, 1);

  // Putting it back in the catalog un-retires it.
  syncItemCatalog(db);
  assert.equal(findItemRow(db, 'soggy-biscuit').retired, 0);
});

test('obtainable defaults to true and is written to the database', () => {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  assert.equal(findItem('soggy-biscuit').obtainable, true);
  assert.equal(findItemRow(db, 'soggy-biscuit').obtainable, 1);
  assert.equal(findItem('jubilee-crumpet').obtainable, false);
  assert.equal(findItemRow(db, 'jubilee-crumpet').obtainable, 0);

  // Flipping the flag in the catalog is picked up by the next sync.
  const reopened = allItems().map((item) => (item.id === 'jubilee-crumpet' ? { ...item, obtainable: true } : item));
  syncItemCatalog(db, reopened);
  assert.equal(findItemRow(db, 'jubilee-crumpet').obtainable, 1);
});

test('a limited-time item cannot be granted but can still be used', async () => {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const pet = adoptPet(db, user.id, { name: 'Pebbles', species: 'gloop' });

  assert.throws(() => grantItem(db, user.id, 'jubilee-crumpet', 1), /no longer being handed out/);
  assert.equal(countOwned(db, user.id, 'jubilee-crumpet'), 0);

  // A player who received one while it was obtainable keeps and uses it.
  addToStack(db, user.id, 'jubilee-crumpet', 1, MAX_STACK_SIZE);
  const shown = listInventory(db, user.id).find((row) => row.item_id === 'jubilee-crumpet');
  assert.equal(shown.obtainable, 0);
  assert.equal(shown.usable, true);
  const result = feedPet(db, user.id, { petId: pet.id, itemId: 'jubilee-crumpet' });
  assert.equal(result.pet.hunger, 90);
  assert.equal(countOwned(db, user.id, 'jubilee-crumpet'), 0);
});

test('a retired item is kept but cannot be used', async () => {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const pet = adoptPet(db, user.id, { name: 'Pebbles', species: 'gloop' });

  // What the sync leaves behind after an item is deleted from the catalog:
  // a row marked retired whose id the catalog no longer knows.
  db.prepare(`
    INSERT INTO items (id, name, description, category, rarity, image, effects, obtainable, retired)
    VALUES ('old-biscuit', 'Old Biscuit', 'From a bygone era.', 'food', 'common', NULL, '{"hunger":10}', 0, 1)
  `).run();
  addToStack(db, user.id, 'old-biscuit', 2, MAX_STACK_SIZE);
  syncItemCatalog(db); // must leave the retired row and the stack alone

  const shown = listInventory(db, user.id).find((row) => row.item_id === 'old-biscuit');
  assert.equal(shown.retired, 1);
  assert.equal(shown.usable, false);
  assert.throws(() => feedPet(db, user.id, { petId: pet.id, itemId: 'old-biscuit' }), /no longer part of the game/);
  assert.throws(() => grantItem(db, user.id, 'old-biscuit', 1), /does not exist/);
  assert.equal(countOwned(db, user.id, 'old-biscuit'), 2);
});
