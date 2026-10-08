import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { getBalance } from '../../src/game/currency.js';
import { countOwned } from '../../src/game/inventory.js';

async function registerAndLogIn(server, username) {
  const token = await server.csrfTokenFrom('/register');
  await server.request('/register', {
    method: 'POST',
    form: { _csrf: token, username, password: 'correct horse' },
  });
  return server.db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

// Fetches the shop page and returns both tokens its buy forms carry.
async function shopTokens(server) {
  const page = await server.request('/shops/questionable-grocer');
  return {
    csrf: page.text.match(/name="_csrf" value="([^"]+)"/)[1],
    purchase: page.text.match(/name="purchase_token" value="([^"]+)"/)[1],
  };
}

test('guests are sent to the login page', async () => {
  const server = startTestServer();
  try {
    assert.equal((await server.request('/shops')).location, '/login');
  } finally {
    server.close();
  }
});

test('the directory and shop page show the balance and prices', async () => {
  const server = startTestServer();
  try {
    await registerAndLogIn(server, 'wobble');
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
    server.close();
  }
});

test('buying charges the catalog price, ignores a forged one, and redirects', async () => {
  const server = startTestServer();
  try {
    const userId = await registerAndLogIn(server, 'wobble');
    const tokens = await shopTokens(server);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: tokens.csrf, purchase_token: tokens.purchase, item: 'humming-turnip', quantity: '2', price: '1', total: '2' },
    });
    assert.equal(submit.status, 302);
    assert.equal(submit.location, '/shops/questionable-grocer');

    const page = await server.request('/shops/questionable-grocer');
    assert.match(page.text, /You bought 2 Humming Turnip for 24 coins\. You have 76 coins left\./);
    assert.match(page.text, /Coins: <strong>76<\/strong>/);
    assert.equal(getBalance(server.db, userId), 76);
    assert.equal(countOwned(server.db, userId, 'humming-turnip'), 3);
  } finally {
    server.close();
  }
});

test('insufficient funds re-shows the shop with an error and no change', async () => {
  const server = startTestServer();
  try {
    const userId = await registerAndLogIn(server, 'wobble');
    const tokens = await shopTokens(server);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: tokens.csrf, purchase_token: tokens.purchase, item: 'pickled-moonbeam', quantity: '2' },
    });
    assert.equal(submit.status, 400);
    assert.match(submit.text, /not have enough coins/);
    assert.equal(getBalance(server.db, userId), 100);
    assert.equal(countOwned(server.db, userId, 'pickled-moonbeam'), 0);
  } finally {
    server.close();
  }
});

test('submitting the same form twice buys once', async () => {
  const server = startTestServer();
  try {
    const userId = await registerAndLogIn(server, 'wobble');
    const tokens = await shopTokens(server);
    const buy = () => server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: tokens.csrf, purchase_token: tokens.purchase, item: 'fizzing-pebble', quantity: '1' },
    });
    const results = await Promise.all([buy(), buy()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [302, 400]);
    assert.match(results.find((r) => r.status === 400).text, /already made/);
    assert.equal(getBalance(server.db, userId), 80, 'charged once');
    assert.equal(countOwned(server.db, userId, 'fizzing-pebble'), 1);

    // A fresh page gives a fresh token, and buying again works.
    const fresh = await shopTokens(server);
    const again = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: fresh.csrf, purchase_token: fresh.purchase, item: 'fizzing-pebble', quantity: '1' },
    });
    assert.equal(again.status, 302);
    assert.equal(getBalance(server.db, userId), 60);
  } finally {
    server.close();
  }
});

test('a request without a purchase token is refused', async () => {
  const server = startTestServer();
  try {
    const userId = await registerAndLogIn(server, 'wobble');
    const tokens = await shopTokens(server);
    const submit = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: tokens.csrf, item: 'soggy-biscuit', quantity: '1' },
    });
    assert.equal(submit.status, 400);
    assert.equal(getBalance(server.db, userId), 100);
  } finally {
    server.close();
  }
});
