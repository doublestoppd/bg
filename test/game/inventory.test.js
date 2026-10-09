import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, databaseWithPlayer } from '../helpers/test-database.js';
import { withTransaction } from '../../src/db/pool.js';
import { registerAccount } from '../../src/game/accounts.js';
import { grantItem, takeItem, countOwned, listInventory, MAX_STACK_SIZE } from '../../src/game/inventory.js';
import { GameRuleError } from '../../src/game/errors.js';


// takeItem insists on a transaction; this runs it in one.
const take = (db, userId, itemId, quantity) => withTransaction(db, (tx) => takeItem(tx, userId, itemId, quantity));

test('granting stacks onto one row per item', async () => {
  const { db, user } = await databaseWithPlayer();
  await grantItem(db, user.id, 'fizzing-pebble', 2);
  await grantItem(db, user.id, 'fizzing-pebble', 3);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 5);
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM inventory WHERE user_id = $1 AND item_id = $2', [user.id, 'fizzing-pebble']);
  assert.equal(rows[0].n, 1);
});

test('invalid grants are refused', async () => {
  const { db, user } = await databaseWithPlayer();
  await assert.rejects(grantItem(db, user.id, 'golden-nothing', 1), GameRuleError);
  await assert.rejects(grantItem(db, user.id, 'jubilee-crumpet', 1), /no longer being handed out/);
  await assert.rejects(grantItem(db, 9999, 'soggy-biscuit', 1), /foreign key/i);
});

test('quantities must be safe whole numbers within the stack limit', async () => {
  const { db, user } = await databaseWithPlayer();
  const bad = [1000, MAX_STACK_SIZE + 1, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, Infinity, NaN, '5', 2.5, -1, 0, null, undefined];
  for (const quantity of bad) {
    await assert.rejects(grantItem(db, user.id, 'fizzing-pebble', quantity), GameRuleError, `grant ${String(quantity)}`);
    await assert.rejects(take(db, user.id, 'soggy-biscuit', quantity), GameRuleError, `take ${String(quantity)}`);
  }
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 0);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 3, 'nothing was taken');
});

test('a stack cannot grow past the limit, even with simultaneous grants', async () => {
  const { db, user } = await databaseWithPlayer();
  await grantItem(db, user.id, 'fizzing-pebble', MAX_STACK_SIZE - 1);
  const results = await Promise.allSettled([
    grantItem(db, user.id, 'fizzing-pebble', 1),
    grantItem(db, user.id, 'fizzing-pebble', 1),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), MAX_STACK_SIZE);
  await take(db, user.id, 'fizzing-pebble', 1);
  await grantItem(db, user.id, 'fizzing-pebble', 1);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), MAX_STACK_SIZE);
});

test('taking decrements a stack and removes it when empty', async () => {
  const { db, user } = await databaseWithPlayer();
  await grantItem(db, user.id, 'fizzing-pebble', 2);
  await take(db, user.id, 'fizzing-pebble', 1);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 1);
  await take(db, user.id, 'fizzing-pebble', 1);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 0);
  const { rows } = await db.query('SELECT 1 FROM inventory WHERE user_id = $1 AND item_id = $2', [user.id, 'fizzing-pebble']);
  assert.equal(rows.length, 0, 'empty stacks are deleted');
});

test('taking more than owned fails and changes nothing', async () => {
  const { db, user } = await databaseWithPlayer();
  await grantItem(db, user.id, 'fizzing-pebble', 2);
  await assert.rejects(take(db, user.id, 'fizzing-pebble', 3), /not have enough/);
  await assert.rejects(take(db, user.id, 'pickled-moonbeam', 1), /not have enough/);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 2);
});

test('takeItem refuses to run outside a transaction', async () => {
  const { db, user } = await databaseWithPlayer();
  await assert.rejects(takeItem(db, user.id, 'soggy-biscuit', 1), /inside withTransaction/);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 3);
});

test("one player cannot see or take another player's items", async () => {
  const { db, user } = await databaseWithPlayer();
  const other = await registerAccount(db, { username: 'nosy', password: 'correct horse' });
  await grantItem(db, user.id, 'pickled-moonbeam', 1);
  assert.equal(await countOwned(db, other.id, 'pickled-moonbeam'), 0);
  assert.ok(!(await listInventory(db, other.id)).some((row) => row.item_id === 'pickled-moonbeam'));
  await assert.rejects(take(db, other.id, 'pickled-moonbeam', 1), /not have enough/);
  assert.equal(await countOwned(db, user.id, 'pickled-moonbeam'), 1);
});

test('the database itself refuses out-of-range or non-integer quantities', async () => {
  const { db, user } = await databaseWithPlayer();
  const insert = (q) => db.query('INSERT INTO inventory (user_id, item_id, quantity) VALUES ($1, $2, $3)', [user.id, 'unlabelled-jar', q]);
  await assert.rejects(insert(MAX_STACK_SIZE + 1), /check/i);
  await assert.rejects(insert(0), /check/i);
  await assert.rejects(insert(2.5), /invalid input syntax/);
  await assert.rejects(insert('lots'), /invalid input syntax/);
  await assert.rejects(db.query('INSERT INTO inventory (user_id, item_id, quantity) VALUES ($1, $2, 1)', [user.id, 'imaginary-item']), /foreign key/i);
  await insert(MAX_STACK_SIZE);
  await assert.rejects(db.query('UPDATE inventory SET quantity = quantity + 1 WHERE item_id = $1', ['unlabelled-jar']), /check/i);
});
