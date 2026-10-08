import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDatabase } from '../helpers/test-database.js';
import { withTransaction } from '../../src/db/pool.js';
import { registerAccount } from '../../src/game/accounts.js';
import { purchaseItem, MAX_PURCHASE_QUANTITY } from '../../src/game/purchases.js';
import { getBalance, awardCoins } from '../../src/game/currency.js';
import { countOwned, grantItem, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { findCoinTransactionsByUser } from '../../src/db/coin-transactions.js';
import { findPurchasesByUser } from '../../src/db/shop-purchases.js';
import { GameRuleError } from '../../src/game/errors.js';

const GROCER = 'questionable-grocer';
const newRequestId = () => crypto.randomUUID();

async function playerDb() {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  return { db, user };
}

async function snapshot(db, userId) {
  return {
    coins: await getBalance(db, userId),
    biscuits: await countOwned(db, userId, 'soggy-biscuit'),
    turnips: await countOwned(db, userId, 'humming-turnip'),
    ledger: (await findCoinTransactionsByUser(db, userId)).length,
    purchases: (await findPurchasesByUser(db, userId)).length,
  };
}

test('a purchase moves coins out, items in, and writes the records', async () => {
  const { db, user } = await playerDb();
  const result = await purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 2, requestId: newRequestId() });
  assert.equal(result.totalCost, 24);
  assert.equal(result.balance, 76);
  assert.equal(result.repeated, false);
  assert.equal(await getBalance(db, user.id), 76);
  assert.equal(await countOwned(db, user.id, 'humming-turnip'), 3);

  const purchase = (await findPurchasesByUser(db, user.id))[0];
  assert.equal(purchase.item_id, 'humming-turnip');
  assert.equal(purchase.total_cost, 24);
  assert.equal(purchase.stock_id, null, 'essentials come from no listing');
  const ledger = (await findCoinTransactionsByUser(db, user.id)).at(-1);
  assert.equal(ledger.reason, 'purchase');
  assert.equal(ledger.amount, -24);
  assert.equal(ledger.purchase_id, purchase.id, 'the ledger row points at the purchase');
});

test('insufficient funds leaves everything unchanged', async () => {
  const { db, user } = await playerDb();
  const before = await snapshot(db, user.id);
  await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 9, requestId: newRequestId() }), /not have enough coins/);
  assert.deepEqual(await snapshot(db, user.id), before);
});

test('unknown shops and items the shop does not sell are refused', async () => {
  const { db, user } = await playerDb();
  const before = await snapshot(db, user.id);
  const buy = (shopId, itemId) => purchaseItem(db, user.id, { shopId, itemId, quantity: 1, requestId: newRequestId() });
  await assert.rejects(buy('black-market', 'soggy-biscuit'), /no such shop/);
  await assert.rejects(buy(GROCER, 'unlabelled-jar'), /does not sell that/);
  await assert.rejects(buy(GROCER, 'fizzing-pebble'), /does not sell that/, 'limited stock is not an essential');
  await assert.rejects(buy(GROCER, 'golden-nothing'), /does not sell that/);
  await assert.rejects(buy(GROCER, 'jubilee-crumpet'), GameRuleError);
  assert.deepEqual(await snapshot(db, user.id), before);
});

test('quantity and request id are validated', async () => {
  const { db, user } = await playerDb();
  const before = await snapshot(db, user.id);
  for (const quantity of [0, -1, 1.5, '2', NaN, Infinity, MAX_PURCHASE_QUANTITY + 1, 21, undefined]) {
    await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity, requestId: newRequestId() }), GameRuleError, String(quantity));
  }
  await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 11, requestId: newRequestId() }), /between 1 and 10/, 'the entry\'s own maxPerPurchase');
  for (const requestId of [undefined, '', 'short', 'has spaces in it here', 42]) {
    await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1, requestId }), /out of date/, String(requestId));
  }
  assert.deepEqual(await snapshot(db, user.id), before);
});

test('the price always comes from the catalog', async () => {
  const { db, user } = await playerDb();
  const result = await purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 3, requestId: newRequestId(), price: 1, totalCost: 1 });
  assert.equal(result.totalCost, 15);
  assert.equal(await getBalance(db, user.id), 85);
});

test('a repeated request id returns the first purchase instead of buying again', async () => {
  const { db, user } = await playerDb();
  const requestId = newRequestId();
  const first = await purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 1, requestId });
  const again = await purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 1, requestId });
  assert.equal(again.repeated, true);
  assert.equal(again.purchaseId, first.purchaseId);
  assert.equal(await getBalance(db, user.id), 88, 'charged once');
  assert.equal(await countOwned(db, user.id, 'humming-turnip'), 2);

  // The same id cannot be used to authorise a different purchase.
  await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 2, requestId }), /already used for something else/);
  await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1, requestId }), /already used for something else/);
  assert.equal(await getBalance(db, user.id), 88);
});

test('simultaneous submissions with one request id buy once', async () => {
  const { db, user } = await playerDb();
  const requestId = newRequestId();
  const buy = () => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 1, requestId });
  const results = await Promise.all([buy(), buy(), buy()]);
  assert.equal(results.filter((r) => !r.repeated).length, 1);
  assert.equal(results.filter((r) => r.repeated).length, 2);
  assert.equal(await getBalance(db, user.id), 88);
  assert.equal(await countOwned(db, user.id, 'humming-turnip'), 2);
  assert.equal((await findPurchasesByUser(db, user.id)).length, 1);
});

test('a full stack rolls the coins and the purchase record back', async () => {
  const { db, user } = await playerDb();
  await withTransaction(db, (tx) => awardCoins(tx, user.id, 10_000, { reason: 'reward' }));
  await grantItem(db, user.id, 'soggy-biscuit', MAX_STACK_SIZE - 3); // welcome biscuits make 999
  const before = await snapshot(db, user.id);
  await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1, requestId: newRequestId() }), /cannot carry more/);
  assert.deepEqual(await snapshot(db, user.id), before);
});

test('a failure after the coins are taken rolls everything back', async () => {
  const { db, user } = await playerDb();
  const before = await snapshot(db, user.id);
  await db.query(`
    CREATE FUNCTION fail_grant() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_grant BEFORE INSERT ON inventory FOR EACH ROW EXECUTE FUNCTION fail_grant();
  `);
  await assert.rejects(purchaseItem(db, user.id, { shopId: GROCER, itemId: 'humming-turnip', quantity: 1, requestId: newRequestId() }), /simulated failure/);
  await db.query('DROP TRIGGER fail_grant ON inventory; DROP FUNCTION fail_grant();');
  assert.deepEqual(await snapshot(db, user.id), before);
});

test('simultaneous purchases stop exactly when the coins run out', async () => {
  const { db, user } = await playerDb();
  const results = await Promise.allSettled(Array.from({ length: 30 }, () =>
    purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1, requestId: newRequestId() })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 20, '100 coins buys twenty 5-coin biscuits');
  for (const r of results.filter((r) => r.status === 'rejected')) assert.ok(r.reason instanceof GameRuleError);
  assert.equal(await getBalance(db, user.id), 0);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 23);
});
