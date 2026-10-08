import { GameRuleError } from './errors.js';
import { findItem } from './items.js';
import { assertInTransaction } from '../db/pool.js';
import { addToStack, findStack, findInventoryByOwner, removeFromStack } from '../db/inventory.js';

// ----- Tunable rules -----
// The most of one item a player can hold. The inventory table enforces
// the same ceiling (see the migration), so raising this needs a migration.
export const MAX_STACK_SIZE = 999;

// Everything the player owns, newest catalog data attached. Rows for
// retired items come back too (players keep what they own) but with
// `usable: false`, since the catalog no longer describes them.
export async function listInventory(db, userId) {
  const rows = await findInventoryByOwner(db, userId);
  return rows.map((row) => ({
    ...row,
    usable: !row.retired && findItem(row.item_id) !== null,
  }));
}

export async function countOwned(db, userId, itemId) {
  const stack = await findStack(db, userId, itemId);
  return stack ? stack.quantity : 0;
}

// Gives a player some of an item. Only items the catalog still hands out
// can be granted, and a stack can never exceed MAX_STACK_SIZE. This is a
// single statement, so it may run on the pool or inside a transaction.
export async function grantItem(db, userId, itemId, quantity) {
  const item = findItem(itemId);
  if (!item) {
    throw new GameRuleError('That item does not exist.');
  }
  if (!item.obtainable) {
    throw new GameRuleError(`${item.name} is no longer being handed out.`);
  }
  assertValidQuantity(quantity);
  if (!(await addToStack(db, userId, itemId, quantity, MAX_STACK_SIZE))) {
    throw new GameRuleError(`You cannot carry more than ${MAX_STACK_SIZE} of one thing.`);
  }
}

// Removes some of an item from a player, failing if they do not have
// enough. Always part of a larger change (feeding, later trading), so it
// insists on a transaction.
export async function takeItem(db, userId, itemId, quantity) {
  assertInTransaction(db, 'takeItem');
  assertValidQuantity(quantity);
  if (!(await removeFromStack(db, userId, itemId, quantity))) {
    throw new GameRuleError('You do not have enough of that item.');
  }
}

// A quantity must be a real whole number from 1 to MAX_STACK_SIZE. Using
// Number.isSafeInteger rejects fractions, NaN, Infinity, strings, and
// numbers too large to count exactly.
function assertValidQuantity(quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_STACK_SIZE) {
    throw new GameRuleError(`Quantity must be a whole number from 1 to ${MAX_STACK_SIZE}.`);
  }
}
