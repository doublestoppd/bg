import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/test-server.js';
import { lowRandom, sequenceRandom } from '../helpers/fixed-random.js';
import { createApp } from '../../src/app.js';
import { ensureShopStates, restockShop } from '../../src/game/restocking.js';
import { SHOP_LIMITS } from '../../src/game/shop-limits.js';
import { pruneActivityLog } from '../../src/game/activity.js';
import { findActivityByUser, findBusiestAccounts } from '../../src/db/activity-log.js';
import { waitForFreshWindow } from '../helpers/rate-limit-window.js';

const MINUTE = 60 * 1000;

async function listingForm(server, listingId) {
  const page = await server.request('/shops/questionable-grocer');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const form = page.text.match(new RegExp(`name="request_id" value="([^"]+)">\\s*<input type="hidden" name="listing" value="${listingId}">\\s*<input type="hidden" name="shown_price" value="(\\d+)"`));
  return { csrf, requestId: form[1], shownPrice: form[2] };
}

async function stocked(server) {
  await ensureShopStates(server.db);
  const result = await restockShop(server.db, 'questionable-grocer', { force: true, random: lowRandom });
  return result.listings.find((l) => l.item_id === 'fizzing-pebble');
}

test('shop page views are limited per account and the limit is logged', async () => {
  const server = await startTestServer();
  try {
    await waitForFreshWindow(MINUTE);
    const userId = await server.registerAndLogIn('wobble');
    let last;
    for (let i = 0; i < SHOP_LIMITS.shopViewsPerMinutePerAccount + 1; i++) {
      last = await server.request('/shops/questionable-grocer');
    }
    assert.equal(last.status, 429);
    assert.match(last.text, /Too many attempts/);
    const log = await findActivityByUser(server.db, userId);
    assert.equal(log[0].kind, 'rate_limited');
    assert.equal(log[0].details.scope, 'shop-view:user');
  } finally {
    await server.close();
  }
});

test('view limits persist across an application restart', async () => {
  const server = await startTestServer();
  try {
    await waitForFreshWindow(MINUTE);
    await server.registerAndLogIn('wobble');
    for (let i = 0; i < SHOP_LIMITS.shopViewsPerMinutePerAccount; i++) await server.request('/shops');
    const second = createApp({ db: server.db }).listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${second.address().port}/shops`, { headers: { cookie: server.cookieHeader() } });
      assert.equal(response.status, 429);
    } finally {
      second.close();
    }
  } finally {
    await server.close();
  }
});

test('accounts sharing one address each get their own allowance, within a larger shared one', async () => {
  const server = await startTestServer({ trustProxy: 1 });
  try {
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    const perAccount = SHOP_LIMITS.shopViewsPerMinutePerAccount;
    const perAddress = SHOP_LIMITS.shopViewsPerMinutePerIp;
    assert.equal(perAddress, 2 * perAccount, 'this test assumes the address allowance is twice the account allowance');

    await waitForFreshWindow(MINUTE, 15000);
    await server.registerAndLogIn('first');
    for (let i = 0; i < perAccount; i++) assert.equal((await server.request('/shops', { headers: ip })).status, 200);
    assert.equal((await server.request('/shops', { headers: ip })).status, 429, 'first account is at its own limit');

    await server.logOut();
    await server.registerAndLogIn('second');
    // A second person in the same household is not affected by the first
    // one's limit. (The first account's refused request never reached the
    // per-address counter.)
    for (let i = 0; i < perAccount; i++) assert.equal((await server.request('/shops', { headers: ip })).status, 200, `second account request ${i}`);

    await server.logOut();
    await server.registerAndLogIn('third');
    assert.equal((await server.request('/shops', { headers: ip })).status, 429, 'the address as a whole is now at its limit');
    assert.equal((await server.request('/shops', { headers: { 'x-forwarded-for': '203.0.113.10' } })).status, 200, 'the same account from another address is fine');
  } finally {
    await server.close();
  }
});

test('purchase attempts are limited per minute', async () => {
  const server = await startTestServer();
  try {
    await waitForFreshWindow(MINUTE);
    await server.registerAndLogIn('wobble');
    const listing = await stocked(server);
    const form = await listingForm(server, listing.id);
    let last;
    for (let i = 0; i < SHOP_LIMITS.purchaseAttemptsPerMinutePerAccount + 1; i++) {
      last = await server.request('/shops/questionable-grocer/buy', {
        method: 'POST',
        form: { _csrf: form.csrf, request_id: form.requestId, listing: listing.id, shown_price: form.shownPrice, quantity: '1' },
      });
    }
    assert.equal(last.status, 429);
  } finally {
    await server.close();
  }
});

test('repeated refused purchases pause buying, and each refusal is logged with its kind', async () => {
  const server = await startTestServer();
  try {
    await waitForFreshWindow(5 * MINUTE);
    const userId = await server.registerAndLogIn('wobble');
    const listing = await stocked(server);
    await server.db.query('UPDATE shop_stock SET remaining_quantity = 0 WHERE id = $1', [listing.id]);
    const form = await listingForm(server, listing.id).catch(() => null); // sold out: no form on the page
    const page = await server.request('/shops/questionable-grocer');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const attempt = () => server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: 'aaaaaaaaaaaaaaaaaaaa', listing: listing.id, shown_price: listing.unit_price, quantity: '1' },
    });
    let last;
    for (let i = 0; i < SHOP_LIMITS.failedPurchasesPerFiveMinutes; i++) {
      last = await attempt();
      assert.equal(last.status, 400, `refusal ${i + 1} is an ordinary refusal`);
      assert.match(last.text, /sold out/);
    }
    last = await attempt();
    assert.equal(last.status, 429);
    assert.match(last.text, /Too many purchases have failed/);

    const log = await findActivityByUser(server.db, userId);
    assert.equal(log[0].kind, 'rate_limited');
    assert.equal(log.filter((row) => row.kind === 'sold_out').length, SHOP_LIMITS.failedPurchasesPerFiveMinutes);
    assert.equal(log[1].stock_id, listing.id);
    assert.equal(log[1].ip, '127.0.0.1');

    const busiest = await findBusiestAccounts(server.db, new Date(Date.now() - 60_000));
    assert.equal(busiest[0].username, 'wobble');
    assert.equal(busiest[0].by_kind.sold_out, SHOP_LIMITS.failedPurchasesPerFiveMinutes);
    assert.ok(form === null);
  } finally {
    await server.close();
  }
});

test('rare purchases are logged, essentials are always purchasable, and old log rows are pruned', async () => {
  const server = await startTestServer();
  try {
    const userId = await server.registerAndLogIn('wobble');
    await ensureShopStates(server.db);
    // One listing, the roll landing on the moonbeam (cumulative weights: pebble 0-9, moonbeam 10-12, jar 13).
    const result = await restockShop(server.db, 'questionable-grocer', { force: true, random: sequenceRandom([1, 10]) });
    const moonbeam = result.listings.find((l) => l.item_id === 'pickled-moonbeam');
    assert.ok(moonbeam, 'the restock contains the moonbeam');
    await server.db.query('UPDATE shop_stock SET unit_price = 55 WHERE id = $1', [moonbeam.id]);
    const form = await listingForm(server, moonbeam.id);
    const bought = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: form.csrf, request_id: form.requestId, listing: moonbeam.id, shown_price: form.shownPrice, quantity: '1' },
    });
    assert.equal(bought.status, 302);
    const log = await findActivityByUser(server.db, userId);
    assert.equal(log[0].kind, 'rare_purchase');
    assert.equal(log[0].details.item, 'pickled-moonbeam');

    // Essentials: no limits beyond the per-minute attempt allowance.
    const page = await server.request('/shops/questionable-grocer');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const essential = page.text.match(/name="request_id" value="([^"]+)">\s*<input type="hidden" name="item" value="soggy-biscuit"/)[1];
    const food = await server.request('/shops/questionable-grocer/buy', {
      method: 'POST',
      form: { _csrf: csrf, request_id: essential, item: 'soggy-biscuit', shown_price: '5', quantity: '2' },
    });
    assert.equal(food.status, 302);

    await server.db.query("UPDATE shop_activity_log SET created_at = now() - interval '31 days'");
    assert.equal(await pruneActivityLog(server.db), 1);
    assert.equal((await findActivityByUser(server.db, userId)).length, 0);
  } finally {
    await server.close();
  }
});
