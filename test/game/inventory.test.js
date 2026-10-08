import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../helpers/test-database.js';
import { registerAccount } from '../../src/game/accounts.js';
import { grantItem, takeItem, countOwned, listInventory, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { GameRuleError } from '../../src/game/errors.js';

async function playerDb() {
  const db = openTestDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  return { db, user };
}

test('granting stacks onto one row per item', async () => {
  const { db, user } = await playerDb();
  const start = countOwned(db, user.id, 'fizzing-pebble');
  grantItem(db, user.id, 'fizzing-pebble', 2);
  grantItem(db, user.id, 'fizzing-pebble', 3);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), start + 5);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM inventory WHERE user_id = ? AND item_id = ?').get(user.id, 'fizzing-pebble');
  assert.equal(rows.n, 1);
});

test('invalid grants are refused', async () => {
  const { db, user } = await playerDb();
  assert.throws(() => grantItem(db, user.id, 'golden-nothing', 1), GameRuleError);
  assert.throws(() => grantItem(db, user.id, 'soggy-biscuit', 0), GameRuleError);
  assert.throws(() => grantItem(db, user.id, 'soggy-biscuit', -2), GameRuleError);
  assert.throws(() => grantItem(db, user.id, 'soggy-biscuit', 1.5), GameRuleError);
  assert.throws(() => grantItem(db, 9999, 'soggy-biscuit', 1), /FOREIGN KEY/);
});

test('taking decrements a stack and removes it when empty', async () => {
  const { db, user } = await playerDb();
  grantItem(db, user.id, 'fizzing-pebble', 2);
  takeItem(db, user.id, 'fizzing-pebble', 1);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), 1);
  takeItem(db, user.id, 'fizzing-pebble', 1);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), 0);
  const row = db.prepare('SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?').get(user.id, 'fizzing-pebble');
  assert.equal(row, undefined, 'empty stacks are deleted');
});

test('taking more than owned fails and changes nothing', async () => {
  const { db, user } = await playerDb();
  grantItem(db, user.id, 'fizzing-pebble', 2);
  assert.throws(() => takeItem(db, user.id, 'fizzing-pebble', 3), /not have enough/);
  assert.throws(() => takeItem(db, user.id, 'pickled-moonbeam', 1), /not have enough/);
  assert.throws(() => takeItem(db, user.id, 'fizzing-pebble', 0), GameRuleError);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), 2);
});

test("one player cannot see or take another player's items", async () => {
  const { db, user } = await playerDb();
  const other = await registerAccount(db, { username: 'nosy', password: 'correct horse' });
  grantItem(db, user.id, 'pickled-moonbeam', 1);

  assert.equal(countOwned(db, other.id, 'pickled-moonbeam'), 0);
  assert.ok(!listInventory(db, other.id).some((row) => row.item_id === 'pickled-moonbeam'));
  assert.throws(() => takeItem(db, other.id, 'pickled-moonbeam', 1), /not have enough/);
  assert.equal(countOwned(db, user.id, 'pickled-moonbeam'), 1);
});

test('the database itself refuses a zero or negative stack', async () => {
  const { db, user } = await playerDb();
  assert.throws(() => db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, 0)').run(user.id, 'unlabelled-jar'), /CHECK/);
  assert.throws(() => db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, 1)').run(user.id, 'imaginary-item'), /FOREIGN KEY/);
});

test('quantities must be safe whole numbers within the stack limit', async () => {
  const { db, user } = await playerDb();
  const bad = [1000, MAX_STACK_SIZE + 1, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, Infinity, NaN, '5', 2.5, -1, 0, null, undefined];
  for (const quantity of bad) {
    assert.throws(() => grantItem(db, user.id, 'fizzing-pebble', quantity), GameRuleError, `grant ${String(quantity)}`);
    assert.throws(() => takeItem(db, user.id, 'soggy-biscuit', quantity), GameRuleError, `take ${String(quantity)}`);
  }
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), 0);
  assert.equal(countOwned(db, user.id, 'soggy-biscuit'), 3, 'nothing was taken');
});

test('a stack cannot grow past the limit, even across several grants', async () => {
  const { db, user } = await playerDb();
  grantItem(db, user.id, 'fizzing-pebble', MAX_STACK_SIZE - 1);
  grantItem(db, user.id, 'fizzing-pebble', 1);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), MAX_STACK_SIZE);
  assert.throws(() => grantItem(db, user.id, 'fizzing-pebble', 1), /cannot carry more than/);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), MAX_STACK_SIZE, 'the refused grant changed nothing');
  takeItem(db, user.id, 'fizzing-pebble', 1);
  grantItem(db, user.id, 'fizzing-pebble', 1);
  assert.equal(countOwned(db, user.id, 'fizzing-pebble'), MAX_STACK_SIZE);
});

test('the database rejects out-of-range or non-integer quantities directly', async () => {
  const { db, user } = await playerDb();
  const insert = db.prepare('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?)');
  assert.throws(() => insert.run(user.id, 'unlabelled-jar', MAX_STACK_SIZE + 1), /CHECK/);
  assert.throws(() => insert.run(user.id, 'unlabelled-jar', 2.5), /CHECK/);
  assert.throws(() => insert.run(user.id, 'unlabelled-jar', 'lots'), /CHECK/);
  assert.throws(() => insert.run(user.id, 'unlabelled-jar', 0), /CHECK/);
  insert.run(user.id, 'unlabelled-jar', MAX_STACK_SIZE);
  assert.throws(() => db.prepare('UPDATE inventory SET quantity = quantity + 1 WHERE item_id = ?').run('unlabelled-jar'), /CHECK/);
  assert.equal(countOwned(db, user.id, 'unlabelled-jar'), MAX_STACK_SIZE);
});
