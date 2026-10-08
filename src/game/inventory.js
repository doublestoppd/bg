import { GameRuleError } from './errors.js';
import { findItem } from './items.js';
import { addToStack, findStack, findInventoryByOwner, removeFromStack } from '../db/inventory.js';

// Everything the player owns, newest catalog data attached. Rows for
// retired items come back too (players keep what they own) but with
// `usable: false`, since the catalog no longer describes them.
export function listInventory(db, userId) {
  return findInventoryByOwner(db, userId).map((row) => ({
    ...row,
    effects: JSON.parse(row.effects),
    usable: row.retired === 0 && findItem(row.item_id) !== null,
  }));
}

export function countOwned(db, userId, itemId) {
  const stack = findStack(db, userId, itemId);
  return stack ? stack.quantity : 0;
}

// Gives a player some of an item. Only catalog items can be granted;
// quantity must be a positive whole number.
export function grantItem(db, userId, itemId, quantity) {
  if (!findItem(itemId)) {
    throw new GameRuleError('That item does not exist.');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new GameRuleError('Quantity must be a whole number greater than zero.');
  }
  addToStack(db, userId, itemId, quantity);
}

// Removes some of an item from a player, failing if they do not have
// enough. The database does the ownership and quantity check in one step.
export function takeItem(db, userId, itemId, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new GameRuleError('Quantity must be a whole number greater than zero.');
  }
  if (!removeFromStack(db, userId, itemId, quantity)) {
    throw new GameRuleError('You do not have enough of that item.');
  }
}
