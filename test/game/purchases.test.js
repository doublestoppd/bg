import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../helpers/test-database.js';
import { registerAccount } from '../../src/game/accounts.js';
import { purchaseItem, MAX_PURCHASE_QUANTITY } from '../../src/game/purchases.js';
import { getBalance, awardCoins } from '../../src/game/currency.js';
import { countOwned, grantItem, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { findCoinTransactionsByUser } from '../../src/db/coin-transactions.js';
import { GameRuleError } from '../../src/game/errors.js';

const GROCER = 'questionable-grocer';

async function playerDb() {
  const db = openTestDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  return { db, user };
}

function snapshot(db, userId) {
  return {
    coins: getBalance(db, userId),
    biscuits: countOwned(db, userId, 'soggy-biscuit'),
    pebbles: countOwned(db, userId, 'fizzing-pebble'),
    ledger: findCoinTransactionsByUser(db, userId).length,
  };
}

test('a purchase moves coins out, items in, and writes the ledger', async () => {
  const { db, user } = await playerDb();
  const result = purchaseItem(db, user.id, { shopId: GROCER, itemId: 'fizzing-pebble', quantity: 2 });
  assert.equal(result.totalCost, 40);
  assert.equal(result.balance, 60);
  assert.equal(getBalance(db, user.id), 60);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), 2);
  const last = findCoinTransactionsByUser(db, user.id).at(-1);
  assert.equal(last.reason, 'purchase');
  assert.equal(last.amount, -40);
  assert.equal(last.balance_after, 60);
  assert.equal(last.shop_id, GROCER);
  assert.equal(last.item_id, 'fizzing-pebble');
  assert.equal(last.quantity, 2);
});

test('insufficient funds leaves balance, inventory and ledger unchanged', async () => {
  const { db, user } = await playerDb();
  const before = snapshot(db, user.id);
  assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'pickled-moonbeam', quantity: 2 }), /not have enough coins/);
  assert.deepEqual(snapshot(db, user.id), before);
});

test('unknown shops and items the shop does not sell are refused', async () => {
  const { db, user } = await playerDb();
  const before = snapshot(db, user.id);
  assert.throws(() => purchaseItem(db, user.id, { shopId: 'black-market', itemId: 'soggy-biscuit', quantity: 1 }), /no such shop/);
  assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'unlabelled-jar', quantity: 1 }), /does not sell that/);
  assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'golden-nothing', quantity: 1 }), /does not sell that/);
  assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'jubilee-crumpet', quantity: 1 }), GameRuleError);
  assert.deepEqual(snapshot(db, user.id), before);
});

test('quantity must be a safe whole number within the per-purchase limit', async () => {
  const { db, user } = await playerDb();
  const before = snapshot(db, user.id);
  for (const quantity of [0, -1, 1.5, '2', NaN, Infinity, MAX_PURCHASE_QUANTITY + 1, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity }), GameRuleError, String(quantity));
  }
  assert.deepEqual(snapshot(db, user.id), before);
});

test('the price always comes from the catalog', async () => {
  const { db, user } = await playerDb();
  // Extra fields that a tampered form might send are simply not read.
  const result = purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 3, price: 1, totalCost: 1 });
  assert.equal(result.totalCost, 15);
  assert.equal(getBalance(db, user.id), 85);
});

test('a full stack rolls the coins back', async () => {
  const { db, user } = await playerDb();
  awardCoins(db, user.id, 10_000, { reason: 'reward' });
  grantItem(db, user.id, 'soggy-biscuit', MAX_STACK_SIZE - 3); // welcome biscuits make 999
  const before = snapshot(db, user.id);
  assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1 }), /cannot carry more/);
  assert.deepEqual(snapshot(db, user.id), before, 'coins were refunded by the rollback');
});

test('a failure after the coins are taken rolls everything back', async () => {
  const { db, user } = await playerDb();
  const before = snapshot(db, user.id);
  db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON inventory BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  assert.throws(() => purchaseItem(db, user.id, { shopId: GROCER, itemId: 'fizzing-pebble', quantity: 1 }), /simulated failure/);
  db.exec('DROP TRIGGER fail_grant');
  assert.deepEqual(snapshot(db, user.id), before);
});

test('repeated purchases stop exactly when the coins run out', async () => {
  const { db, user } = await playerDb();
  let successes = 0;
  for (let i = 0; i < 30; i++) {
    try {
      purchaseItem(db, user.id, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1 });
      successes++;
    } catch (error) {
      assert.ok(error instanceof GameRuleError);
    }
  }
  assert.equal(successes, 20, '100 coins buys twenty 5-coin biscuits');
  assert.equal(getBalance(db, user.id), 0);
  assert.equal(countOwned(db, user.id, 'soggy-biscuit'), 23);
});
