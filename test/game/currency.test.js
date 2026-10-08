import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../helpers/test-database.js';
import { registerAccount, STARTING_COINS } from '../../src/game/accounts.js';
import { getBalance, spendCoins, awardCoins, MAX_COINS } from '../../src/game/currency.js';
import { findCoinTransactionsByUser } from '../../src/db/coin-transactions.js';
import { GameRuleError } from '../../src/game/errors.js';

async function playerDb() {
  const db = openTestDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  return { db, user };
}

test('the welcome purse is recorded in the ledger', async () => {
  const { db, user } = await playerDb();
  assert.equal(user.coins, STARTING_COINS);
  assert.equal(getBalance(db, user.id), STARTING_COINS);
  const ledger = findCoinTransactionsByUser(db, user.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].reason, 'welcome');
  assert.equal(ledger[0].amount, STARTING_COINS);
  assert.equal(ledger[0].balance_after, STARTING_COINS);
});

test('spending and awarding change the balance and the ledger together', async () => {
  const { db, user } = await playerDb();
  assert.equal(spendCoins(db, user.id, 30, { reason: 'purchase', shopId: 's', itemId: 'soggy-biscuit', quantity: 6 }), 70);
  assert.equal(awardCoins(db, user.id, 5, { reason: 'reward' }), 75);
  assert.equal(getBalance(db, user.id), 75);
  const ledger = findCoinTransactionsByUser(db, user.id);
  assert.deepEqual(ledger.map((row) => row.amount), [100, -30, 5]);
  assert.deepEqual(ledger.map((row) => row.balance_after), [100, 70, 75]);
  const sum = ledger.reduce((total, row) => total + row.amount, 0);
  assert.equal(sum, getBalance(db, user.id), 'the ledger always sums to the balance');
});

test('spending more than the balance fails and changes nothing', async () => {
  const { db, user } = await playerDb();
  assert.throws(() => spendCoins(db, user.id, 101, { reason: 'purchase' }), /not have enough coins/);
  assert.equal(getBalance(db, user.id), 100);
  assert.equal(findCoinTransactionsByUser(db, user.id).length, 1);
  spendCoins(db, user.id, 100, { reason: 'purchase' });
  assert.equal(getBalance(db, user.id), 0);
  assert.throws(() => spendCoins(db, user.id, 1, { reason: 'purchase' }), GameRuleError);
  assert.equal(getBalance(db, user.id), 0, 'never negative');
});

test('a purse cannot overflow', async () => {
  const { db, user } = await playerDb();
  awardCoins(db, user.id, MAX_COINS - 100, { reason: 'reward' });
  assert.equal(getBalance(db, user.id), MAX_COINS);
  assert.throws(() => awardCoins(db, user.id, 1, { reason: 'reward' }), /cannot hold more/);
  assert.equal(getBalance(db, user.id), MAX_COINS);
});

test('amounts must be safe whole numbers within limits', async () => {
  const { db, user } = await playerDb();
  for (const amount of [0, -5, 1.5, '10', NaN, Infinity, MAX_COINS + 1, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => spendCoins(db, user.id, amount, { reason: 'purchase' }), GameRuleError, `spend ${String(amount)}`);
    assert.throws(() => awardCoins(db, user.id, amount, { reason: 'reward' }), GameRuleError, `award ${String(amount)}`);
  }
  assert.equal(getBalance(db, user.id), 100);
  assert.equal(findCoinTransactionsByUser(db, user.id).length, 1);
});

test('the database itself refuses a negative or oversized balance', async () => {
  const { db, user } = await playerDb();
  assert.throws(() => db.prepare('UPDATE users SET coins = -1 WHERE id = ?').run(user.id), /CHECK/);
  assert.throws(() => db.prepare('UPDATE users SET coins = ? WHERE id = ?').run(MAX_COINS + 1, user.id), /CHECK/);
  assert.throws(() => db.prepare('UPDATE users SET coins = 1.5 WHERE id = ?').run(user.id), /CHECK/);
  assert.equal(getBalance(db, user.id), 100);
});
