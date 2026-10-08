import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/connection.js';
import { allItems, findItem, syncItemCatalog, CATEGORIES, RARITIES } from '../../src/game/items.js';
import { allItemRows, findItemRow } from '../../src/db/items.js';
import { registerAccount } from '../../src/game/accounts.js';
import { countOwned, listInventory } from '../../src/game/inventory.js';

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
