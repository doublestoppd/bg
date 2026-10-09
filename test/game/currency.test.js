import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, databaseWithPlayer } from '../helpers/test-database.js';
import { withTransaction } from '../../src/db/pool.js';
import { registerAccount, STARTING_COINS } from '../../src/game/accounts.js';
import { getBalance, spendCoins, awardCoins, MAX_COINS } from '../../src/game/currency.js';
import { findCoinTransactionsByUser } from '../../src/db/coin-transactions.js';
import { GameRuleError } from '../../src/game/errors.js';

const spend = (db, userId, amount, details) => withTransaction(db, (tx) => spendCoins(tx, userId, amount, details));
const award = (db, userId, amount, details) => withTransaction(db, (tx) => awardCoins(tx, userId, amount, details));

test('the welcome purse is recorded in the ledger', async () => {
  const { db, user } = await databaseWithPlayer();
  assert.equal(user.coins, STARTING_COINS);
  assert.equal(await getBalance(db, user.id), STARTING_COINS);
  const ledger = await findCoinTransactionsByUser(db, user.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].reason, 'welcome');
  assert.equal(ledger[0].amount, STARTING_COINS);
  assert.equal(ledger[0].balance_after, STARTING_COINS);
});

test('spending and awarding change the balance and the ledger together', async () => {
  const { db, user } = await databaseWithPlayer();
  assert.equal(await spend(db, user.id, 30, { reason: 'purchase', shopId: 's', itemId: 'soggy-biscuit', quantity: 6 }), 70);
  assert.equal(await award(db, user.id, 5, { reason: 'reward' }), 75);
  assert.equal(await getBalance(db, user.id), 75);
  const ledger = await findCoinTransactionsByUser(db, user.id);
  assert.deepEqual(ledger.map((row) => row.amount), [100, -30, 5]);
  assert.deepEqual(ledger.map((row) => row.balance_after), [100, 70, 75]);
  const sum = ledger.reduce((total, row) => total + row.amount, 0);
  assert.equal(sum, await getBalance(db, user.id), 'the ledger always sums to the balance');
});

test('spending more than the balance fails and changes nothing', async () => {
  const { db, user } = await databaseWithPlayer();
  await assert.rejects(spend(db, user.id, 101, { reason: 'purchase' }), /not have enough coins/);
  assert.equal(await getBalance(db, user.id), 100);
  assert.equal((await findCoinTransactionsByUser(db, user.id)).length, 1);
  await spend(db, user.id, 100, { reason: 'purchase' });
  assert.equal(await getBalance(db, user.id), 0);
  await assert.rejects(spend(db, user.id, 1, { reason: 'purchase' }), GameRuleError);
  assert.equal(await getBalance(db, user.id), 0, 'never negative');
});

test('simultaneous spends cannot overdraw the purse', async () => {
  const { db, user } = await databaseWithPlayer();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => spend(db, user.id, 30, { reason: 'purchase' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, '100 coins covers three 30-coin spends');
  assert.equal(await getBalance(db, user.id), 10);
  const ledger = await findCoinTransactionsByUser(db, user.id);
  assert.equal(ledger.reduce((t, row) => t + row.amount, 0), 10);
});

test('a purse cannot overflow', async () => {
  const { db, user } = await databaseWithPlayer();
  await award(db, user.id, MAX_COINS - 100, { reason: 'reward' });
  assert.equal(await getBalance(db, user.id), MAX_COINS);
  await assert.rejects(award(db, user.id, 1, { reason: 'reward' }), /cannot hold more/);
  assert.equal(await getBalance(db, user.id), MAX_COINS);
});

test('amounts must be safe whole numbers within limits', async () => {
  const { db, user } = await databaseWithPlayer();
  for (const amount of [0, -5, 1.5, '10', NaN, Infinity, MAX_COINS + 1, Number.MAX_SAFE_INTEGER + 1, null]) {
    await assert.rejects(spend(db, user.id, amount, { reason: 'purchase' }), GameRuleError, `spend ${String(amount)}`);
    await assert.rejects(award(db, user.id, amount, { reason: 'reward' }), GameRuleError, `award ${String(amount)}`);
  }
  assert.equal(await getBalance(db, user.id), 100);
});

test('coin changes refuse to run outside a transaction', async () => {
  const { db, user } = await databaseWithPlayer();
  await assert.rejects(spendCoins(db, user.id, 1, { reason: 'purchase' }), /inside withTransaction/);
  assert.equal(await getBalance(db, user.id), 100);
});

test('the database itself refuses a negative or oversized balance', async () => {
  const { db, user } = await databaseWithPlayer();
  await assert.rejects(db.query('UPDATE users SET coins = -1 WHERE id = $1', [user.id]), /check/i);
  await assert.rejects(db.query('UPDATE users SET coins = $1 WHERE id = $2', [MAX_COINS + 1, user.id]), /check/i);
  assert.equal(await getBalance(db, user.id), 100);
});
