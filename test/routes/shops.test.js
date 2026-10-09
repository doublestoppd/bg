import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { getBalance } from '../../src/game/currency.js';
import { countOwned } from '../../src/game/inventory.js';
import { ensureShopStates, restockShop, restockShopWithDefinition } from '../../src/game/restocking.js';
import { findShop } from '../../src/game/shops.js';
import { stockOne } from '../helpers/shop-fixtures.js';
import { highRandom, lowRandom } from '../helpers/fixed-random.js';

const GROCER = 'questionable-grocer';
const listingForm = (server, listingId) => server.listingForm(GROCER, listingId);

// Puts one fixed listing on the grocer's shelves and returns it.
async function stocked(server, itemId, overrides) {
  await ensureShopStates(server.db);
  return stockOne(server.db, itemId, overrides);
}

test('guests are sent to the login page', async () => {
  const server = await startTestServer();
  try {
    assert.equal((await server.request('/shops')).location, '/login');
  } finally {
    await server.close();
  }
});

test('the directory and shop page show the balance and prices', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    const directory = await server.request('/shops');
    assert.equal(directory.status, 200);
    assert.match(directory.text, /The Questionable Grocer/);
    assert.match(directory.text, /<strong>100<\/strong> coins/);
    const shop = await server.request('/shops/questionable-grocer');
    assert.match(shop.text, /Mungle:/);
    assert.match(shop.text, /Coins: <strong>100<\/strong>/, 'purse in the menu');
    assert.match(shop.text, /shelves are bare/, 'no restock has happened yet');
    assert.doesNotMatch(shop.text, /Always in stock/);
    assert.equal((await server.request('/shops/black-market')).status, 404);
  } finally {
    await server.close();
  }
});

test('buying charges the listing price, ignores a forged one, and redirects', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const turnip = await stocked(server, 'humming-turnip', { quantity: 6, price: 12, maxPerPurchase: 10, maxPerRestock: 20 });
    const { csrf, requestId, shownPrice } = await listingForm(server, turnip.id);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: requestId, listing: turnip.id, shown_price: shownPrice, quantity: '2', price: '1', total: '2' },
    });
    assert.equal(submit.status, 302);
    assert.equal(submit.location, '/shops/questionable-grocer');
    const page = await server.request('/shops/questionable-grocer');
    assert.match(page.text, /You bought 2 Humming Turnip for 24 coins\. You have 76 coins left\. 4 left on the shelf\./);
    assert.match(page.text, /Coins: <strong>76<\/strong>/);
    assert.equal(await getBalance(server.db, userId), 76);
    assert.equal(await countOwned(server.db, userId, 'humming-turnip'), 3);
  } finally {
    await server.close();
  }
});

test('insufficient funds re-shows the shop with an error and no change', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const turnip = await stocked(server, 'humming-turnip', { quantity: 10, price: 12, maxPerPurchase: 10, maxPerRestock: 20 });
    const { csrf, requestId, shownPrice } = await listingForm(server, turnip.id);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: requestId, listing: turnip.id, shown_price: shownPrice, quantity: '9' },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /not have enough coins/);
    assert.equal(await getBalance(server.db, userId), 100);
    assert.equal(await countOwned(server.db, userId, 'humming-turnip'), 1);
  } finally {
    await server.close();
  }
});

test('submitting the same form twice buys once', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const turnip = await stocked(server, 'humming-turnip', { quantity: 6, price: 12, maxPerPurchase: 10, maxPerRestock: 20 });
    const { csrf, requestId, shownPrice } = await listingForm(server, turnip.id);
    const buy = () => server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: requestId, listing: turnip.id, shown_price: shownPrice, quantity: '1' },
    });
    const results = await Promise.all([buy(), buy()]);
    assert.deepEqual(results.map((r) => r.status), [302, 302], 'both are answered kindly');
    assert.equal(await getBalance(server.db, userId), 88, 'charged once');
    assert.equal(await countOwned(server.db, userId, 'humming-turnip'), 2);
    assert.match((await server.request('/shops/questionable-grocer')).text, /had already gone through|You bought 1 Humming Turnip/);

    const fresh = await listingForm(server, turnip.id);
    const again = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: fresh.csrf, request_id: fresh.requestId, listing: turnip.id, shown_price: fresh.shownPrice, quantity: '1' },
    });
    assert.equal(again.status, 302);
    assert.equal(await getBalance(server.db, userId), 76);
  } finally {
    await server.close();
  }
});

test('a request without a request id is refused', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const biscuit = await stocked(server, 'soggy-biscuit', { quantity: 10, price: 5 });
    const { csrf, shownPrice } = await listingForm(server, biscuit.id);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, listing: biscuit.id, shown_price: shownPrice, quantity: '1' },
    });
    assert.equal(submit.status, 400);
    assert.equal(await getBalance(server.db, userId), 100);
  } finally {
    await server.close();
  }
});

test('the shop page shows current listings with remaining stock and sold-out states', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    await ensureShopStates(server.db);
    // Two listings for this page test (the real grocer draws one at a time).
    const grocer = findShop('questionable-grocer');
    const result = await restockShopWithDefinition(server.db, { ...grocer, restock: { ...grocer.restock, listingsMin: 2, listingsMax: 2 } }, { force: true, random: highRandom });
    await server.db.query('UPDATE shop_stock SET remaining_quantity = 0 WHERE id = $1', [result.listings[0].id]);

    const page = await server.request('/shops/questionable-grocer');
    assert.match(page.text, /On the shelves today/);
    assert.match(page.text, /Sold out/);
    assert.match(page.text, new RegExp(`<span class="remaining">${result.listings[1].remaining_quantity}</span> left`));
    assert.match(page.text, new RegExp(`${result.listings[1].unit_price} coins each`));
    assert.doesNotMatch(page.text, /next_restock|restock_at/, 'no schedule leaks to the page');
  } finally {
    await server.close();
  }
});

test('a player can buy a limited listing from the shelves, and it shows as sold out when gone', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const listing = await stocked(server, 'fizzing-pebble', { quantity: 1, price: 18 });

    const form = await listingForm(server, listing.id);
    assert.ok(form, 'the listing has a buy form');
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: form.csrf, request_id: form.requestId, listing: listing.id, shown_price: form.shownPrice, quantity: '1' },
    });
    assert.equal(submit.status, 302);
    const page = await server.request('/shops/questionable-grocer');
    assert.match(page.text, /You bought 1 Fizzing Pebble for 18 coins\. You have 82 coins left\. That was the last of them\./);
    assert.match(page.text, /Sold out/);
    assert.equal(await listingForm(server, listing.id), null, 'no buy form once sold out');
    assert.equal(await countOwned(server.db, userId, 'fizzing-pebble'), 1);
  } finally {
    await server.close();
  }
});

test('a tampered shown price is refused with a clear message', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const listing = await stocked(server, 'fizzing-pebble');
    const form = await listingForm(server, listing.id);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: form.csrf, request_id: form.requestId, listing: listing.id, shown_price: '1', quantity: '1' },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /price of Fizzing Pebble has changed/);
    assert.equal(await getBalance(server.db, userId), 100);
  } finally {
    await server.close();
  }
});

test('the stock feed reports remaining quantities and the restock id, never the schedule', async () => {
  const server = await startTestServer();
  try {
    await server.registerAndLogIn('wobble');
    await ensureShopStates(server.db);
    const result = await restockShop(server.db, 'questionable-grocer', { force: true, random: lowRandom });
    const feed = await server.request('/shops/questionable-grocer/stock.json');
    assert.equal(feed.status, 200);
    const stock = JSON.parse(feed.text);
    assert.equal(stock.restockId, result.event.id);
    assert.equal(stock.paused, false);
    assert.deepEqual(stock.listings.map((l) => l.id).sort(), result.listings.map((l) => l.id).sort());
    assert.ok(stock.listings.every((l) => Object.keys(l).join() === 'id,remaining'));
    assert.doesNotMatch(feed.text, /next|restock_at/);
    assert.equal((await server.request('/shops/nowhere/stock.json')).status, 404);

    const page = await server.request('/shops/questionable-grocer');
    assert.match(page.text, /Mungle last restocked the shelves moments ago/);
    assert.match(page.text, /data-restock="\d+"/);
    assert.match(page.text, /src="\/js\/shop\.js"/);
  } finally {
    await server.close();
  }
});
