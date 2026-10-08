import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { GameRuleError } from './errors.js';
import { findUserByUsernameWithPassword, insertUser, usernameExists } from '../db/users.js';

// ----- Tunable rules -----
export const STARTING_COINS = 100;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

// Creates a new account and returns the user row (without the password).
export async function registerAccount(db, { username, password }) {
  const cleanUsername = String(username || '').trim();

  if (cleanUsername.length < USERNAME_MIN_LENGTH || cleanUsername.length > USERNAME_MAX_LENGTH) {
    throw new GameRuleError(`Usernames must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`);
  }
  if (!USERNAME_PATTERN.test(cleanUsername)) {
    throw new GameRuleError('Usernames may only contain letters, numbers and underscores.');
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new GameRuleError(`Passwords must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  // Hashing is slow by design, so it happens before the transaction;
  // better-sqlite3 transactions must not contain any awaits.
  const passwordHash = await hashPassword(password);

  // The check and the insert happen in one transaction so two people
  // registering the same name at once cannot both succeed.
  return db.transaction(() => {
    if (usernameExists(db, cleanUsername)) {
      throw new GameRuleError('That username is already taken.');
    }
    return insertUser(db, { username: cleanUsername, passwordHash, coins: STARTING_COINS });
  })();
}

// Checks a username and password. Returns the user row on success.
// The error message is deliberately the same whether the username or the
// password was wrong, so the form cannot be used to discover usernames.
export async function authenticate(db, { username, password }) {
  const user = findUserByUsernameWithPassword(db, String(username || '').trim());
  const passwordOk = user !== null && await verifyPassword(String(password || ''), user.password_hash);
  if (!passwordOk) {
    throw new GameRuleError('That username and password do not match.');
  }
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

// ----- Password hashing -----
// Stored as "scrypt$<salt hex>$<hash hex>". Keeping the algorithm name in the
// string means a future change of algorithm can tell old hashes from new.
// The asynchronous scrypt runs in Node's thread pool, so a burst of logins
// does not freeze page serving for everyone else.

const SCRYPT_KEY_LENGTH = 64;
const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, hashHex] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
