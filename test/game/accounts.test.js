import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/connection.js';
import { registerAccount, authenticate, STARTING_COINS, hashPassword, verifyPassword } from '../../src/game/accounts.js';
import { GameRuleError } from '../../src/game/errors.js';

test('registering creates a user with starting coins', () => {
  const db = openDatabase(':memory:');
  const user = registerAccount(db, { username: 'wobble', password: 'correct horse' });
  assert.equal(user.username, 'wobble');
  assert.equal(user.coins, STARTING_COINS);
  assert.equal(user.password_hash, undefined, 'password hash must not be returned');
});

test('usernames must be unique, ignoring case', () => {
  const db = openDatabase(':memory:');
  registerAccount(db, { username: 'Wobble', password: 'correct horse' });
  assert.throws(() => registerAccount(db, { username: 'wobble', password: 'another one' }), GameRuleError);
});

test('bad usernames and short passwords are rejected', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => registerAccount(db, { username: 'ab', password: 'long enough' }), GameRuleError);
  assert.throws(() => registerAccount(db, { username: 'has space', password: 'long enough' }), GameRuleError);
  assert.throws(() => registerAccount(db, { username: 'fine', password: 'short' }), GameRuleError);
});

test('authenticate accepts the right password and rejects the wrong one', () => {
  const db = openDatabase(':memory:');
  registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const user = authenticate(db, { username: 'wobble', password: 'correct horse' });
  assert.equal(user.username, 'wobble');
  assert.throws(() => authenticate(db, { username: 'wobble', password: 'wrong' }), GameRuleError);
  assert.throws(() => authenticate(db, { username: 'nobody', password: 'correct horse' }), GameRuleError);
});

test('password hashes are salted and verifiable', () => {
  const first = hashPassword('secret words');
  const second = hashPassword('secret words');
  assert.notEqual(first, second, 'same password should produce different hashes');
  assert.ok(verifyPassword('secret words', first));
  assert.ok(!verifyPassword('other words', first));
  assert.ok(!verifyPassword('secret words', 'garbage'));
});
