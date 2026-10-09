import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { databaseWithPlayer } from '../helpers/test-database.js';
import { stockOne } from '../helpers/shop-fixtures.js';
import { createPool, withTransaction } from '../../src/db/pool.js';
import config from '../../src/config.js';
import { registerAccount } from '../../src/game/accounts.js';
import { purchaseItem, MAX_PURCHASE_QUANTITY } from '../../src/game/purchases.js';
import { ensureShopStates } from '../../src/game/restocking.js';
import { getBalance, awardCoins } from '../../src/game/currency.js';
import { countOwned, grantItem, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { findCoinTransactionsByUser } from '../../src/db/coin-transactions.js';
import { findPurchasesByUser } from '../../src/db/shop-purchases.js';
import { findActiveListings, findListingsByRestock } from '../../src/db/shop-stock.js';
import { setShopPaused } from '../../src/db/shop-state.js';
import { GameRuleError } from '../../src/game/errors.js';

const GROCER = 'questionable-grocer';
const newRequestId = () => crypto.randomUUID();

async function setup() {
  const { db, user } = await databaseWithPlayer();
  await ensureShopStates(db);
  return { db, user };
}

function buy(db, userId, listing, quantity, extra = {}) {
  return purchaseItem(db, userId, { shopId: GROCER, listingId: listing.id, quantity, shownPrice: listing.unit_price, requestId: newRequestId(), ...extra });
}

async function remaining(db, listing) {
  const { rows } = await db.query('SELECT remaining_quantity, active FROM shop_stock WHERE id = $1', [listing.id]);
  return rows[0];
}

async function snapshot(db, userId, listing) {
  return {
    coins: await getBalance(db, userId),
    pebbles: await countOwned(db, userId, 'fizzing-pebble'),
    ledger: (await findCoinTransactionsByUser(db, userId)).length,
    purchases: (await findPurchasesByUser(db, userId)).length,
    shelf: await remaining(db, listing),
  };
}

test('1. buying a listing takes stock, coins, and gives the item, with full records', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 20 });
  const result = await buy(db, user.id, listing, 2);
  assert.equal(result.totalCost, 40);
  assert.equal(result.balance, 60);
  assert.equal(result.remaining, 3);
  assert.equal(await getBalance(db, user.id), 60);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 2);
  assert.equal((await remaining(db, listing)).remaining_quantity, 3);
  const purchase = (await findPurchasesByUser(db, user.id))[0];
  assert.equal(purchase.stock_id, listing.id);
  assert.equal(purchase.restock_id, listing.restock_id);
  assert.equal(purchase.unit_price, 20);
  const ledger = (await findCoinTransactionsByUser(db, user.id)).at(-1);
  assert.equal(ledger.purchase_id, purchase.id);
  assert.equal(ledger.amount, -40);
});

test('2. insufficient currency changes nothing, including the shelf', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 60 });
  const before = await snapshot(db, user.id, listing);
  await assert.rejects(buy(db, user.id, listing, 2), /not have enough coins/);
  assert.deepEqual(await snapshot(db, user.id, listing), before);
});

test('3. a sold-out listing and an over-ask are refused', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 2, price: 10 });
  await assert.rejects(buy(db, user.id, listing, 3), /Only 2 Fizzing Pebble left/);
  await buy(db, user.id, listing, 2);
  await assert.rejects(buy(db, user.id, listing, 1), /sold out/);
  assert.equal((await remaining(db, listing)).remaining_quantity, 0);
  assert.equal(await getBalance(db, user.id), 80);
});

test('4. and 5. unknown shops, unknown listings, and listings of another shop are refused', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble');
  const before = await snapshot(db, user.id, listing);
  await assert.rejects(purchaseItem(db, user.id, { shopId: 'black-market', listingId: listing.id, quantity: 1, shownPrice: 20, requestId: newRequestId() }), /no such shop/);
  await assert.rejects(buy(db, user.id, { id: 999999, unit_price: 20 }, 1), /does not sell that/);
  await assert.rejects(buy(db, user.id, { id: 'abc', unit_price: 20 }, 1), /does not sell that/);
  await assert.rejects(buy(db, user.id, { id: undefined, unit_price: 20 }, 1), /does not sell that/);
  await assert.rejects(buy(db, user.id, { id: '', unit_price: 20 }, 1), /does not sell that/);
  await db.query("INSERT INTO shop_state (shop_id, next_restock_at) VALUES ('other-shop', now())");
  await db.query("UPDATE shop_stock SET shop_id = 'other-shop' WHERE id = $1", [listing.id]);
  await assert.rejects(buy(db, user.id, listing, 1), /does not sell that/, 'a listing that belongs to another shop');
  await db.query("UPDATE shop_stock SET shop_id = $2 WHERE id = $1", [listing.id, GROCER]);
  assert.deepEqual(await snapshot(db, user.id, listing), before);
});

test('6. an expired listing (replaced by a restock) cannot be bought', async () => {
  const { db, user } = await setup();
  const old = await stockOne(db, 'fizzing-pebble');
  await stockOne(db, 'pickled-moonbeam'); // the next restock retires it
  const before = await snapshot(db, user.id, old);
  assert.equal(before.shelf.active, false);
  await assert.rejects(buy(db, user.id, old, 1), /shelves have been restocked/);
  assert.deepEqual(await snapshot(db, user.id, old), before);
});

test('a paused shop does not sell, even to a saved form', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });
  await setShopPaused(db, GROCER, true);
  await assert.rejects(buy(db, user.id, listing, 1), /closed at the moment/);
  assert.equal((await remaining(db, listing)).remaining_quantity, 5);
  assert.equal(await getBalance(db, user.id), 100);
  await setShopPaused(db, GROCER, false);
  await buy(db, user.id, listing, 1);
  assert.equal((await remaining(db, listing)).remaining_quantity, 4);
});

test('7. a forged or stale shown price is refused and never charged', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { price: 20 });
  await assert.rejects(buy(db, user.id, listing, 1, { shownPrice: 1 }), /price of Fizzing Pebble has changed/);
  await assert.rejects(buy(db, user.id, listing, 1, { shownPrice: 21 }), /has changed/);
  assert.equal(await getBalance(db, user.id), 100);
  assert.equal((await remaining(db, listing)).remaining_quantity, 2);
  const ok = await buy(db, user.id, listing, 1, { price: 1, total: 1 });
  assert.equal(ok.totalCost, 20, 'extra fields are ignored');
});

test('8. quantity, request id and shown price must be valid', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 10, price: 5 });
  for (const quantity of [0, -1, 1.5, '2', NaN, Infinity, MAX_PURCHASE_QUANTITY + 1, undefined]) {
    await assert.rejects(buy(db, user.id, listing, quantity), GameRuleError, String(quantity));
  }
  for (const requestId of [undefined, '', 'short', 'has spaces in it here', 42]) {
    await assert.rejects(buy(db, user.id, listing, 1, { requestId }), /out of date/, String(requestId));
  }
  for (const shownPrice of [undefined, 0, -5, 1.5, '5']) {
    await assert.rejects(buy(db, user.id, listing, 1, { shownPrice }), /out of date/, String(shownPrice));
  }
  assert.equal((await remaining(db, listing)).remaining_quantity, 10);
});

test('a full stack rolls the coins, the stock and the purchase record back', async () => {
  const { db, user } = await setup();
  await withTransaction(db, (tx) => awardCoins(tx, user.id, 10_000, { reason: 'reward' }));
  await grantItem(db, user.id, 'fizzing-pebble', MAX_STACK_SIZE);
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 1 });
  const before = await snapshot(db, user.id, listing);
  await assert.rejects(buy(db, user.id, listing, 1), /cannot carry more/);
  assert.deepEqual(await snapshot(db, user.id, listing), before);
});

test('simultaneous purchases stop exactly when the coins run out', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'soggy-biscuit', { quantity: 100, price: 5 });
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => buy(db, user.id, listing, 1)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 20, '100 coins buys twenty 5-coin biscuits');
  for (const r of results.filter((r) => r.status === 'rejected')) assert.ok(r.reason instanceof GameRuleError);
  assert.equal(await getBalance(db, user.id), 0);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 23);
  assert.equal((await remaining(db, listing)).remaining_quantity, 80);
});

test('10. a duplicate request id replays the first purchase; a reused one for a different purchase is refused', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });
  const requestId = newRequestId();
  const first = await buy(db, user.id, listing, 1, { requestId });
  const again = await buy(db, user.id, listing, 1, { requestId });
  assert.equal(again.repeated, true);
  assert.equal(again.purchaseId, first.purchaseId);
  assert.equal(await getBalance(db, user.id), 90);
  assert.equal((await remaining(db, listing)).remaining_quantity, 4);
  await assert.rejects(buy(db, user.id, listing, 2, { requestId }), /already used for something else/);
  assert.equal((await remaining(db, listing)).remaining_quantity, 4);
});

test('11. simultaneous duplicate requests buy once', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });
  const requestId = newRequestId();
  const results = await Promise.all(Array.from({ length: 4 }, () => buy(db, user.id, listing, 1, { requestId })));
  assert.equal(results.filter((r) => !r.repeated).length, 1);
  assert.equal((await remaining(db, listing)).remaining_quantity, 4);
  assert.equal(await getBalance(db, user.id), 90);
});

test('12. two players racing for the last copy on separate connections: exactly one wins', async () => {
  const { db, user } = await setup();
  const rival = await registerAccount(db, { username: 'rival', password: 'correct horse' });
  const listing = await stockOne(db, 'pickled-moonbeam', { quantity: 1, price: 60 });
  const other = createPool(config.testDatabaseUrl);
  try {
    const results = await Promise.allSettled([
      buy(db, user.id, listing, 1),
      buy(other, rival.id, listing, 1),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    assert.equal(winners.length, 1);
    const loser = results.find((r) => r.status === 'rejected');
    assert.match(loser.reason.message, /sold out/);
    assert.equal((await remaining(db, listing)).remaining_quantity, 0);
    const owned = (await countOwned(db, user.id, 'pickled-moonbeam')) + (await countOwned(db, rival.id, 'pickled-moonbeam'));
    assert.equal(owned, 1, 'one copy exists');
    const balances = (await getBalance(db, user.id)) + (await getBalance(db, rival.id));
    assert.equal(balances, 140, 'one player paid');
  } finally {
    await other.end();
  }
});

test('13. a failure while granting the item rolls back coins and stock', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });
  const before = await snapshot(db, user.id, listing);
  await db.query(`
    CREATE FUNCTION fail_grant() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_grant BEFORE INSERT ON inventory FOR EACH ROW EXECUTE FUNCTION fail_grant();
  `);
  await assert.rejects(buy(db, user.id, listing, 1), /simulated failure/);
  await db.query('DROP TRIGGER fail_grant ON inventory; DROP FUNCTION fail_grant();');
  assert.deepEqual(await snapshot(db, user.id, listing), before);
});

test('14. a failure while charging coins rolls back the stock decrement', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });
  const before = await snapshot(db, user.id, listing);
  await db.query(`
    CREATE FUNCTION fail_ledger() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_ledger BEFORE INSERT ON coin_transactions FOR EACH ROW EXECUTE FUNCTION fail_ledger();
  `);
  await assert.rejects(buy(db, user.id, listing, 1), /simulated failure/);
  await db.query('DROP TRIGGER fail_ledger ON coin_transactions; DROP FUNCTION fail_ledger();');
  assert.deepEqual(await snapshot(db, user.id, listing), before, 'stock is back on the shelf');
});

test('17. stock can never go negative, even under a crowd', async () => {
  const { db } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 3, price: 1 });
  const players = [];
  for (let i = 0; i < 8; i++) players.push(await registerAccount(db, { username: `player${i}`, password: 'correct horse' }));
  const results = await Promise.allSettled(players.map((p) => buy(db, p.id, listing, 1)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal((await remaining(db, listing)).remaining_quantity, 0);
  await assert.rejects(db.query('UPDATE shop_stock SET remaining_quantity = -1 WHERE id = $1', [listing.id]), /check/i);
  const { rows } = await db.query('SELECT SUM(quantity)::int AS sold FROM shop_purchases WHERE stock_id = $1', [listing.id]);
  assert.equal(rows[0].sold, 3, 'purchase records match the stock that left');
});

test('19. a restock that replaces a listing waits for a purchase in flight, and later buyers see it as gone', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });

  // Hold the listing's lock as a purchase would, start a restock (it must
  // wait), then release and confirm the order of events.
  const holder = await db.connect();
  const events = [];
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM shop_stock WHERE id = $1 FOR UPDATE', [listing.id]);
    const restockPromise = stockOne(db, 'pickled-moonbeam').then((l) => { events.push('restock done'); return l; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(events, [], 'the restock is blocked behind the purchase lock');
    events.push('purchase released');
    await holder.query('COMMIT');
    await restockPromise;
    assert.deepEqual(events, ['purchase released', 'restock done']);
  } finally {
    holder.release();
  }
  await assert.rejects(buy(db, user.id, listing, 1), /shelves have been restocked/);

  // The other order: a restock in progress blocks a purchase, which then
  // fails cleanly instead of selling from a retired listing.
  const fresh = (await findActiveListings(db, GROCER))[0];
  const restocker = await db.connect();
  try {
    await restocker.query('BEGIN');
    await restocker.query('UPDATE shop_stock SET active = false WHERE id = $1', [fresh.id]);
    const purchasePromise = buy(db, user.id, fresh, 1).then(() => 'bought', (e) => e.message);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await restocker.query('COMMIT');
    assert.match(await purchasePromise, /shelves have been restocked/);
  } finally {
    restocker.release();
  }
});

test('the ledger, purchases and stock agree after a busy restock', async () => {
  const { db } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 12, price: 7 });
  const players = [];
  for (let i = 0; i < 6; i++) {
    const p = await registerAccount(db, { username: `player${i}`, password: 'correct horse' });
    await withTransaction(db, (tx) => awardCoins(tx, p.id, 100, { reason: 'reward' }));
    players.push(p);
  }
  const attempts = players.flatMap((p) => [1, 2, 3].map((q) => buy(db, p.id, listing, q)));
  await Promise.allSettled(attempts);
  const shelf = await remaining(db, listing);
  const { rows: [sold] } = await db.query('SELECT COALESCE(SUM(quantity), 0)::int AS n FROM shop_purchases WHERE stock_id = $1', [listing.id]);
  assert.equal(12 - shelf.remaining_quantity, sold.n, 'stock that left equals stock recorded as sold');
  for (const p of players) {
    const ledger = await findCoinTransactionsByUser(db, p.id);
    assert.equal(ledger.reduce((t, r) => t + r.amount, 0), await getBalance(db, p.id));
    assert.equal((await countOwned(db, p.id, 'fizzing-pebble')), (await db.query('SELECT COALESCE(SUM(quantity), 0)::int AS n FROM shop_purchases WHERE user_id = $1', [p.id])).rows[0].n);
  }
});

// ----- retries of a completed purchase after the shelf has changed -----

test('a retry after the listing sold out returns the original purchase, charging nothing', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 1, price: 10 });
  const requestId = newRequestId();
  const first = await buy(db, user.id, listing, 1, { requestId });
  assert.equal((await remaining(db, listing)).remaining_quantity, 0);
  const before = await snapshot(db, user.id, listing);

  const retry = await buy(db, user.id, listing, 1, { requestId });
  assert.equal(retry.repeated, true);
  assert.equal(retry.purchaseId, first.purchaseId);
  assert.equal(retry.item.name, 'Fizzing Pebble');
  assert.deepEqual(await snapshot(db, user.id, listing), before, 'no second charge, no second item');
});

test('a retry after a restock replaced the listing returns the original purchase', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 3, price: 10 });
  const requestId = newRequestId();
  const first = await buy(db, user.id, listing, 2, { requestId });
  await stockOne(db, 'pickled-moonbeam'); // retires the pebble listing
  assert.equal((await remaining(db, listing)).active, false);
  const before = await snapshot(db, user.id, listing);

  const retry = await buy(db, user.id, listing, 2, { requestId });
  assert.equal(retry.repeated, true);
  assert.equal(retry.purchaseId, first.purchaseId);
  assert.equal(retry.quantity, 2);
  assert.deepEqual(await snapshot(db, user.id, listing), before);
  // A fresh request for the gone listing is still refused as expired.
  await assert.rejects(buy(db, user.id, listing, 1), /shelves have been restocked/);
});

test('a retry after a price change returns the original purchase; a changed request is refused', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 5, price: 10 });
  const requestId = newRequestId();
  const first = await buy(db, user.id, listing, 1, { requestId });
  await db.query('UPDATE shop_stock SET unit_price = 25 WHERE id = $1', [listing.id]);
  const before = await snapshot(db, user.id, listing);

  // Same form resent: same shown price as the original purchase.
  const retry = await buy(db, user.id, listing, 1, { requestId, shownPrice: 10 });
  assert.equal(retry.repeated, true);
  assert.equal(retry.purchaseId, first.purchaseId);
  assert.equal(retry.unitPrice, 10, 'the price actually paid, not the new one');
  assert.deepEqual(await snapshot(db, user.id, listing), before);

  // The same request id with different details is not a retry.
  await assert.rejects(buy(db, user.id, listing, 1, { requestId, shownPrice: 25 }), /already used for something else/);
  await assert.rejects(buy(db, user.id, listing, 2, { requestId, shownPrice: 10 }), /already used for something else/);
  assert.deepEqual(await snapshot(db, user.id, listing), before);
});

test('concurrent retries of one request for the last copy charge once and grant once', async () => {
  const { db, user } = await setup();
  const listing = await stockOne(db, 'fizzing-pebble', { quantity: 1, price: 10 });
  const requestId = newRequestId();
  const other = createPool(config.testDatabaseUrl);
  try {
    const attempts = [db, other, db, other, db].map((p) => buy(p, user.id, listing, 1, { requestId }));
    const results = await Promise.all(attempts);
    assert.equal(results.filter((r) => !r.repeated).length, 1, 'one real purchase');
    assert.equal(results.filter((r) => r.repeated).length, 4, 'every other copy of the request was answered with it');
    assert.ok(results.every((r) => r.purchaseId === results[0].purchaseId));
    assert.equal(await getBalance(db, user.id), 90, 'charged once');
    assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 1, 'granted once');
    assert.equal((await remaining(db, listing)).remaining_quantity, 0);
    assert.equal((await findPurchasesByUser(db, user.id)).length, 1);
  } finally {
    await other.end();
  }
});
