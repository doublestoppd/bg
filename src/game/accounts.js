import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { GameRuleError } from './errors.js';
import { withTransaction } from '../db/pool.js';
import { findUserByUsernameWithPassword, insertUser, usernameExists } from '../db/users.js';
import { grantItem } from './inventory.js';
import { awardCoins } from './currency.js';

// ----- Tunable rules -----
export const STARTING_COINS = 100;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
// A few things to feed a first pet with. Item ids come from game/items.js.
export const WELCOME_ITEMS = [
  { itemId: 'soggy-biscuit', quantity: 3 },
  { itemId: 'humming-turnip', quantity: 1 },
];

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

// Creates a new account and returns the user row (without the password).
export async function registerAccount(pool, { username, password }) {
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
  // the transaction below stays short and holds no locks while hashing.
  const passwordHash = await hashPassword(password);

  // The check and the insert happen in one transaction; the unique index
  // on the username is the final guard if two people race for one name.
  return withTransaction(pool, async (db) => {
    if (await usernameExists(db, cleanUsername)) {
      throw new GameRuleError('That username is already taken.');
    }
    const user = await insertUser(db, { username: cleanUsername, passwordHash, coins: 0 });
    // The starting purse goes through the ledger like every other change.
    user.coins = await awardCoins(db, user.id, STARTING_COINS, { reason: 'welcome' });
    for (const gift of WELCOME_ITEMS) {
      await grantItem(db, user.id, gift.itemId, gift.quantity);
    }
    return user;
  });
}

// Checks a username and password. Returns the user row on success.
// The error message is deliberately the same whether the username or the
// password was wrong, so the form cannot be used to discover usernames.
export async function authenticate(db, { username, password }) {
  const user = await findUserByUsernameWithPassword(db, String(username || '').trim());
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
