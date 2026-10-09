import { GameRuleError } from './errors.js';
import { assertInTransaction } from '../db/pool.js';
import { findCoins, subtractCoins, addCoins } from '../db/users.js';
import { insertCoinTransaction } from '../db/coin-transactions.js';

// The only place coin balances change. Every change is one conditional
// UPDATE (so a balance can never go below zero or above the ceiling, even
// under concurrent requests) plus a ledger row in coin_transactions. Both
// statements must commit together, so these functions take the client of
// a transaction opened with withTransaction, never the bare pool.
//
// `details` describes the ledger entry: { reason, shopId, itemId, quantity,
// purchaseId }. reason is a short word such as 'purchase' or 'welcome'; the
// rest is only filled in for purchases.

// ----- Tunable rules -----
// The most coins one player can hold. The users table enforces the same
// ceiling (see the migration), so raising this needs a migration.
export const MAX_COINS = 1_000_000_000;

export async function getBalance(db, userId) {
  const coins = await findCoins(db, userId);
  if (coins === null) throw new Error(`No user ${userId}`);
  return coins;
}

// Takes coins away, failing if the player cannot afford it. Returns the
// new balance.
export async function spendCoins(db, userId, amount, details) {
  assertInTransaction(db, 'spendCoins');
  assertValidAmount(amount);
  if (!(await subtractCoins(db, userId, amount))) {
    throw new GameRuleError('You do not have enough coins.');
  }
  return recordChange(db, userId, -amount, details);
}

// Gives coins, failing if the player's purse would overflow. Returns the
// new balance.
export async function awardCoins(db, userId, amount, details) {
  assertInTransaction(db, 'awardCoins');
  assertValidAmount(amount);
  if (!(await addCoins(db, userId, amount, MAX_COINS))) {
    throw new GameRuleError(`A purse cannot hold more than ${MAX_COINS} coins.`);
  }
  return recordChange(db, userId, amount, details);
}

async function recordChange(db, userId, signedAmount, { reason, shopId = null, itemId = null, quantity = null, purchaseId = null }) {
  if (!reason) throw new Error('A coin transaction needs a reason');
  const balanceAfter = await getBalance(db, userId);
  await insertCoinTransaction(db, { userId, amount: signedAmount, balanceAfter, reason, shopId, itemId, quantity, purchaseId });
  return balanceAfter;
}

function assertValidAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_COINS) {
    throw new GameRuleError(`Coin amounts must be whole numbers from 1 to ${MAX_COINS}.`);
  }
}
