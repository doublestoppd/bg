import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allShops, findShop, findOffer, MAX_PRICE } from '../../src/game/shops.js';
import { findItem } from '../../src/game/items.js';

test('the shop catalog is well formed', () => {
  const ids = allShops().map((shop) => shop.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const shop of allShops()) {
    assert.ok(shop.merchandise.length > 0, `${shop.id} sells something`);
    for (const { itemId, price } of shop.merchandise) {
      const item = findItem(itemId);
      assert.ok(item, `${shop.id} sells a real item (${itemId})`);
      assert.ok(item.obtainable, `${itemId} is still obtainable`);
      assert.ok(Number.isSafeInteger(price) && price >= 1 && price <= MAX_PRICE);
    }
  }
});

test('offers are looked up per shop', () => {
  assert.equal(findShop('questionable-grocer').name, 'The Questionable Grocer');
  assert.equal(findShop('nowhere'), null);
  const offer = findOffer('questionable-grocer', 'soggy-biscuit');
  assert.equal(offer.price, 5);
  assert.equal(offer.item.name, 'Soggy Biscuit');
  assert.equal(findOffer('questionable-grocer', 'unlabelled-jar'), null, 'in the catalog but not on sale here');
  assert.equal(findOffer('nowhere', 'soggy-biscuit'), null);
});
