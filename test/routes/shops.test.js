import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { getBalance } from '../../src/game/currency.js';
import { countOwned } from '../../src/game/inventory.js';

// Fetches the shop page and returns the CSRF token plus the request id of
// the buy form for one item.
async function buyForm(server, itemId) {
  const page = await server.request('/shops/questionable-grocer');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const form = page.text.match(new RegExp(`name="request_id" value="([^"]+)">\\s*<input type="hidden" name="item" value="${itemId}"`));
  return { csrf, requestId: form[1] };
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
    assert.match(shop.text, /Define fresh/);
    assert.match(shop.text, /12 coins each/);
    assert.match(shop.text, /Coins: <strong>100<\/strong>/, 'purse in the menu');
    assert.equal((await server.request('/shops/black-market')).status, 404);
  } finally {
    await server.close();
  }
});

test('buying charges the catalog price, ignores a forged one, and redirects', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const { csrf, requestId } = await buyForm(server, 'humming-turnip');
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: requestId, item: 'humming-turnip', quantity: '2', price: '1', total: '2' },
    });
    assert.equal(submit.status, 302);
    assert.equal(submit.location, '/shops/questionable-grocer');
    const page = await server.request('/shops/questionable-grocer');
    assert.match(page.text, /You bought 2 Humming Turnip for 24 coins\. You have 76 coins left\./);
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
    const { csrf, requestId } = await buyForm(server, 'pickled-moonbeam');
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: requestId, item: 'pickled-moonbeam', quantity: '2' },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /not have enough coins/);
    assert.equal(await getBalance(server.db, userId), 100);
    assert.equal(await countOwned(server.db, userId, 'pickled-moonbeam'), 0);
  } finally {
    await server.close();
  }
});

test('submitting the same form twice buys once', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const { csrf, requestId } = await buyForm(server, 'fizzing-pebble');
    const buy = () => server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: requestId, item: 'fizzing-pebble', quantity: '1' },
    });
    const results = await Promise.all([buy(), buy()]);
    assert.deepEqual(results.map((r) => r.status), [302, 302], 'both are answered kindly');
    assert.equal(await getBalance(server.db, userId), 80, 'charged once');
    assert.equal(await countOwned(server.db, userId, 'fizzing-pebble'), 1);
    assert.match((await server.request('/shops/questionable-grocer')).text, /had already gone through|You bought 1 Fizzing Pebble/);

    const fresh = await buyForm(server, 'fizzing-pebble');
    const again = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: fresh.csrf, request_id: fresh.requestId, item: 'fizzing-pebble', quantity: '1' },
    });
    assert.equal(again.status, 302);
    assert.equal(await getBalance(server.db, userId), 60);
  } finally {
    await server.close();
  }
});

test('a request without a request id is refused', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    const { csrf } = await buyForm(server, 'soggy-biscuit');
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, item: 'soggy-biscuit', quantity: '1' },
    });
    assert.equal(submit.status, 400);
    assert.equal(await getBalance(server.db, userId), 100);
  } finally {
    await server.close();
  }
});
