import { GameRuleError } from './errors.js';
import { findCoins, subtractCoins, addCoins } from '../db/users.js';
import { insertCoinTransaction } from '../db/coin-transactions.js';

// The only place coin balances change. Every change is one conditional
// UPDATE (so a balance can never go below zero or above the ceiling, even
// under concurrent requests) plus a ledger row in coin_transactions.
//
// `details` describes the ledger entry: { reason, shopId, itemId, quantity }.
// reason is a short word such as 'purchase' or 'welcome'; the rest is only
// filled in for purchases.

// ----- Tunable rules -----
// The most coins one player can hold. The users table enforces the same
// ceiling (see migration 004), so raising this needs a migration.
export const MAX_COINS = 1_000_000_000;

export function getBalance(db, userId) {
  const coins = findCoins(db, userId);
  if (coins === null) throw new Error(`No user ${userId}`);
  return coins;
}

// Takes coins away, failing if the player cannot afford it.
export function spendCoins(db, userId, amount, details) {
  assertValidAmount(amount);
  return db.transaction(() => {
    if (subtractCoins(db, userId, amount) !== 1) {
      throw new GameRuleError('You do not have enough coins.');
    }
    return recordChange(db, userId, -amount, details);
  })();
}

// Gives coins, failing if the player's purse would overflow.
export function awardCoins(db, userId, amount, details) {
  assertValidAmount(amount);
  return db.transaction(() => {
    if (addCoins(db, userId, amount, MAX_COINS) !== 1) {
      throw new GameRuleError(`A purse cannot hold more than ${MAX_COINS} coins.`);
    }
    return recordChange(db, userId, amount, details);
  })();
}

// Writes the ledger row and returns the new balance.
function recordChange(db, userId, signedAmount, { reason, shopId = null, itemId = null, quantity = null }) {
  if (!reason) throw new Error('A coin transaction needs a reason');
  const balanceAfter = getBalance(db, userId);
  insertCoinTransaction(db, { userId, amount: signedAmount, balanceAfter, reason, shopId, itemId, quantity });
  return balanceAfter;
}

function assertValidAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_COINS) {
    throw new GameRuleError(`Coin amounts must be whole numbers from 1 to ${MAX_COINS}.`);
  }
}
