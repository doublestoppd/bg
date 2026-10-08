import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/connection.js';
import { registerAccount, authenticate, STARTING_COINS, hashPassword, verifyPassword } from '../../src/game/accounts.js';
import { GameRuleError } from '../../src/game/errors.js';

test('registering creates a user with starting coins', async () => {
  const db = openDatabase(':memory:');
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  assert.equal(user.username, 'wobble');
  assert.equal(user.coins, STARTING_COINS);
  assert.equal(user.password_hash, undefined, 'password hash must not be returned');
});

test('usernames must be unique, ignoring case', async () => {
  const db = openDatabase(':memory:');
  await registerAccount(db, { username: 'Wobble', password: 'correct horse' });
  await assert.rejects(registerAccount(db, { username: 'wobble', password: 'another one' }), GameRuleError);
});

test('bad usernames and short passwords are rejected', async () => {
  const db = openDatabase(':memory:');
  await assert.rejects(registerAccount(db, { username: 'ab', password: 'long enough' }), GameRuleError);
  await assert.rejects(registerAccount(db, { username: 'has space', password: 'long enough' }), GameRuleError);
  await assert.rejects(registerAccount(db, { username: 'fine', password: 'short' }), GameRuleError);
});

test('authenticate accepts the right password and rejects the wrong one', async () => {
  const db = openDatabase(':memory:');
  await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const user = await authenticate(db, { username: 'wobble', password: 'correct horse' });
  assert.equal(user.username, 'wobble');
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
