import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allShops, findShop, findEssential, findPoolEntry, quantityRangeFor, RARITY_QUANTITY_RANGES, MAX_PRICE } from '../../src/game/shops.js';
import { findItem } from '../../src/game/items.js';

test('the shop catalog is well formed', () => {
  const ids = allShops().map((shop) => shop.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const shop of allShops()) {
    assert.ok(shop.essentials.length + shop.restockPool.length > 0, `${shop.id} sells something`);
    assert.ok(shop.restock.minMinutes <= shop.restock.maxMinutes);
    for (const entry of [...shop.essentials, ...shop.restockPool]) {
      const item = findItem(entry.itemId);
      assert.ok(item, `${shop.id} sells a real item (${entry.itemId})`);
      assert.ok(item.obtainable, `${entry.itemId} is still obtainable`);
    }
    for (const entry of shop.restockPool) {
      assert.ok(entry.price[0] <= entry.price[1] && entry.price[1] <= MAX_PRICE);
      const [lo, hi] = quantityRangeFor(entry);
      assert.ok(lo >= 1 && lo <= hi);
    }
  }
});

test('essentials and pool entries are looked up per shop', () => {
  assert.equal(findShop('questionable-grocer').keeper.name, 'Mungle');
  assert.equal(findShop('nowhere'), null);
  const biscuit = findEssential('questionable-grocer', 'soggy-biscuit');
  assert.equal(biscuit.price, 5);
  assert.equal(biscuit.item.name, 'Soggy Biscuit');
  assert.equal(findEssential('questionable-grocer', 'fizzing-pebble'), null, 'limited stock is not an essential');
  assert.equal(findPoolEntry('questionable-grocer', 'fizzing-pebble').weight, 10);
  assert.equal(findPoolEntry('questionable-grocer', 'soggy-biscuit'), null);
  assert.equal(findPoolEntry('nowhere', 'fizzing-pebble'), null);
});

test('quantity ranges default by rarity unless the entry overrides them', () => {
  assert.deepEqual(quantityRangeFor({ itemId: 'fizzing-pebble' }), RARITY_QUANTITY_RANGES.uncommon);
  assert.deepEqual(quantityRangeFor({ itemId: 'pickled-moonbeam' }), RARITY_QUANTITY_RANGES.rare);
  assert.deepEqual(quantityRangeFor({ itemId: 'pickled-moonbeam', quantity: [7, 9] }), [7, 9]);
});

test('a restock may draw at most half the pool, so weights always decide', async () => {
  const { planRestock } = await import('../../src/game/restocking.js');
  const { lowRandom } = await import('../helpers/fixed-random.js');
  const grocer = findShop('questionable-grocer');
  // The catalog rule, checked on every real shop at startup.
  assert.ok(grocer.restock.listingsMax <= Math.floor(grocer.restockPool.length / 2), 'the grocer draws at most half its pool');
  // The planner's own guard against a definition that would list the whole pool.
  const wholePool = { ...grocer, restock: { ...grocer.restock, listingsMin: 1, listingsMax: grocer.restockPool.length } };
  assert.throws(() => planRestock(wholePool, lowRandom), /whole pool/);
  const tooMany = { ...grocer, restock: { ...grocer.restock, listingsMin: 4, listingsMax: 8 } };
  assert.throws(() => planRestock(tooMany, lowRandom), /whole pool/);
});
