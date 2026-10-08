import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase } from '../helpers/test-database.js';
import { registerAccount, authenticate, STARTING_COINS, hashPassword, verifyPassword } from '../../src/game/accounts.js';
import { countOwned } from '../../src/game/inventory.js';
import { GameRuleError } from '../../src/game/errors.js';

test('registering creates a user with starting coins and welcome items', async () => {
  const db = await resetDatabase();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  assert.equal(user.username, 'wobble');
  assert.equal(user.coins, STARTING_COINS);
  assert.equal(user.password_hash, undefined, 'password hash must not be returned');
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 3);
});

test('usernames must be unique, ignoring case', async () => {
  const db = await resetDatabase();
  await registerAccount(db, { username: 'Wobble', password: 'correct horse' });
  await assert.rejects(registerAccount(db, { username: 'wobble', password: 'another one' }), GameRuleError);
  await assert.rejects(registerAccount(db, { username: 'WOBBLE', password: 'another one' }), GameRuleError);
});

test('two simultaneous registrations of one name create one account', async () => {
  const db = await resetDatabase();
  const results = await Promise.allSettled([
    registerAccount(db, { username: 'twin', password: 'correct horse' }),
    registerAccount(db, { username: 'Twin', password: 'correct horse' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1);
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(rows[0].n, 1);
});

test('bad usernames and short passwords are rejected', async () => {
  const db = await resetDatabase();
  await assert.rejects(registerAccount(db, { username: 'ab', password: 'long enough' }), GameRuleError);
  await assert.rejects(registerAccount(db, { username: 'has space', password: 'long enough' }), GameRuleError);
  await assert.rejects(registerAccount(db, { username: 'fine', password: 'short' }), GameRuleError);
});

test('authenticate accepts the right password and rejects the wrong one', async () => {
  const db = await resetDatabase();
  await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const user = await authenticate(db, { username: 'wobble', password: 'correct horse' });
  assert.equal(user.username, 'wobble');
  assert.equal(user.password_hash, undefined);
  await assert.rejects(authenticate(db, { username: 'wobble', password: 'wrong' }), GameRuleError);
  await assert.rejects(authenticate(db, { username: 'nobody', password: 'correct horse' }), GameRuleError);
});

test('password hashes are salted and verifiable', async () => {
  const first = await hashPassword('secret words');
  const second = await hashPassword('secret words');
  assert.notEqual(first, second, 'same password should produce different hashes');
  assert.ok(await verifyPassword('secret words', first));
  assert.ok(!(await verifyPassword('other words', first)));
  assert.ok(!(await verifyPassword('secret words', 'garbage')));
});
