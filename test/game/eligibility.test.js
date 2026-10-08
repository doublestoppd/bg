import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDatabase } from '../helpers/test-database.js';
import { lowRandom } from '../helpers/fixed-random.js';
import { createPool, withTransaction } from '../../src/db/pool.js';
import config from '../../src/config.js';
import { registerAccount } from '../../src/game/accounts.js';
import { adoptPet } from '../../src/game/pets.js';
import { purchaseItem } from '../../src/game/purchases.js';
import { ensureShopStates, restockShopWithDefinition } from '../../src/game/restocking.js';
import { findShop } from '../../src/game/shops.js';
import { awardCoins, getBalance } from '../../src/game/currency.js';
import { countOwned } from '../../src/game/inventory.js';
import { SHOP_LIMITS } from '../../src/game/shop-limits.js';
import { insertRestriction, liftRestrictions, findActiveRestriction } from '../../src/db/restrictions.js';

const GROCER = 'questionable-grocer';
const grocer = findShop(GROCER);
const newRequestId = () => crypto.randomUUID();

async function stockOne(db, itemId, overrides = {}) {
  const entry = grocer.restockPool.find((e) => e.itemId === itemId);
  const definition = {
    ...grocer,
    restock: { ...grocer.restock, listingsMin: 1, listingsMax: 1 },
    restockPool: [{ ...entry, quantity: [50, 50], price: [1, 1], maxPerPurchase: 1, maxPerRestock: 100, dailySupplyCap: undefined, ...overrides }],
  };
  return (await restockShopWithDefinition(db, definition, { force: true, random: lowRandom })).listings[0];
}

async function setup() {
  const db = await resetDatabase();
  await ensureShopStates(db);
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  await withTransaction(db, (tx) => awardCoins(tx, user.id, 1000, { reason: 'reward' }));
  return { db, user };
}

const buy = (db, userId, listing, quantity = 1) =>
  purchaseItem(db, userId, { shopId: GROCER, listingId: listing.id, quantity, shownPrice: listing.unit_price, requestId: newRequestId() });
const buyEssential = (db, userId) =>
  purchaseItem(db, userId, { shopId: GROCER, itemId: 'soggy-biscuit', quantity: 1, shownPrice: 5, requestId: newRequestId() });

test('a new account cannot buy high-value merchandise until it is old enough and has a pet', async () => {
  const { db, user } = await setup();
  const jar = await stockOne(db, 'unlabelled-jar'); // needs 24 hours and a pet
  await assert.rejects(buy(db, user.id, jar), /citizens of at least 1 day/);
  await db.query("UPDATE users SET created_at = now() - interval '25 hours' WHERE id = $1", [user.id]);
  await assert.rejects(buy(db, user.id, jar), /people with a pet at home/);
  await adoptPet(db, user.id, { name: 'Pebbles', species: 'gloop' });
  const result = await buy(db, user.id, jar);
  assert.equal(result.item.id, 'unlabelled-jar');
  assert.equal(await countOwned(db, user.id, 'unlabelled-jar'), 1);
});

test('ordinary limited stock and essentials have no eligibility rules', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  await buy(db, user.id, pebble);
  await buyEssential(db, user.id);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 1);
});

test('a restricted account cannot buy limited stock but can still buy essentials', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  await insertRestriction(db, { userId: user.id, reason: 'bought 40 moonbeams in a minute', createdBy: 'admin:keeper' });
  await assert.rejects(buy(db, user.id, pebble), /suspended: bought 40 moonbeams/);
  await buyEssential(db, user.id);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 4, 'food is always available');

  assert.equal(await liftRestrictions(db, user.id, 'admin:keeper'), 1);
  assert.equal(await findActiveRestriction(db, user.id), null);
  await buy(db, user.id, pebble);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 1);
});

test('a restriction with an expiry lapses by itself, and one without lasts until lifted', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  await insertRestriction(db, { userId: user.id, reason: 'temporary', createdBy: 'admin:keeper', expiresAt: new Date(Date.now() - 1000) });
  await buy(db, user.id, pebble); // already expired
  await insertRestriction(db, { userId: user.id, reason: 'until further notice', createdBy: 'admin:keeper' });
  await assert.rejects(buy(db, user.id, pebble), /until further notice/);
});

test('restrictions and limits persist across a restart (a fresh pool over the same database)', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  await insertRestriction(db, { userId: user.id, reason: 'reviewed', createdBy: 'admin:keeper' });
  const restarted = createPool(config.testDatabaseUrl);
  try {
    await assert.rejects(buy(restarted, user.id, pebble), /suspended: reviewed/);
  } finally {
    await restarted.end();
  }
});

test('an account may buy at most the hourly number of limited items, even with simultaneous requests', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  const limit = SHOP_LIMITS.listingPurchasesPerHour;
  const results = await Promise.allSettled(Array.from({ length: limit + 5 }, () => buy(db, user.id, pebble)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, limit);
  const refused = results.find((r) => r.status === 'rejected');
  assert.match(refused.reason.message, /most allowed/);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), limit);

  // Purchases older than an hour no longer count.
  await db.query("UPDATE shop_purchases SET created_at = created_at - interval '2 hours' WHERE user_id = $1", [user.id]);
  await buy(db, user.id, pebble);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), limit + 1);

  // Essentials are never counted against it.
  await db.query("UPDATE shop_purchases SET created_at = now() WHERE user_id = $1", [user.id]);
  await buyEssential(db, user.id);
  assert.equal(await getBalance(db, user.id), 1100 - limit - 1 - 5);
});
