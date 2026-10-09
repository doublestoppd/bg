import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { databaseWithPlayer } from '../helpers/test-database.js';
import { stockOne as stockOneListing } from '../helpers/shop-fixtures.js';
import { createPool, withTransaction } from '../../src/db/pool.js';
import config from '../../src/config.js';
import { adoptPet } from '../../src/game/pets.js';
import { purchaseItem } from '../../src/game/purchases.js';
import { ensureShopStates } from '../../src/game/restocking.js';
import { awardCoins, getBalance } from '../../src/game/currency.js';
import { countOwned } from '../../src/game/inventory.js';
import { SHOP_LIMITS } from '../../src/game/shop-limits.js';
import { insertRestriction, liftRestrictions, findActiveRestriction } from '../../src/db/restrictions.js';

const GROCER = 'questionable-grocer';
const newRequestId = () => crypto.randomUUID();

// Plenty of cheap copies, so nothing but the rule under test gets in the way.
const stockOne = (db, itemId) => stockOneListing(db, itemId, { quantity: 50, price: 1 });

async function setup() {
  const { db, user } = await databaseWithPlayer();
  await ensureShopStates(db);
  await withTransaction(db, (tx) => awardCoins(tx, user.id, 1000, { reason: 'reward' }));
  return { db, user };
}

const buy = (db, userId, listing, quantity = 1) =>
  purchaseItem(db, userId, { shopId: GROCER, listingId: listing.id, quantity, shownPrice: listing.unit_price, requestId: newRequestId() });

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

test('ordinary merchandise has no eligibility rules', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  await buy(db, user.id, pebble);
  const biscuit = await stockOne(db, 'soggy-biscuit');
  await buy(db, user.id, biscuit);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), 1);
  assert.equal(await countOwned(db, user.id, 'soggy-biscuit'), 4);
});

test('a restricted account cannot buy from shops until the restriction is lifted', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  await insertRestriction(db, { userId: user.id, reason: 'bought 40 moonbeams in a minute', createdBy: 'admin:keeper' });
  await assert.rejects(buy(db, user.id, pebble), /suspended: bought 40 moonbeams/);

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

test('an account may buy at most the hourly number of times, even with simultaneous requests', async () => {
  const { db, user } = await setup();
  const pebble = await stockOne(db, 'fizzing-pebble');
  const limit = SHOP_LIMITS.purchasesPerHour;
  const results = await Promise.allSettled(Array.from({ length: limit + 5 }, () => buy(db, user.id, pebble)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, limit);
  const refused = results.find((r) => r.status === 'rejected');
  assert.match(refused.reason.message, /most allowed/);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), limit);

  // Purchases older than an hour no longer count.
  await db.query("UPDATE shop_purchases SET created_at = created_at - interval '2 hours' WHERE user_id = $1", [user.id]);
  await buy(db, user.id, pebble);
  assert.equal(await countOwned(db, user.id, 'fizzing-pebble'), limit + 1);
  assert.equal(await getBalance(db, user.id), 1100 - limit - 1);
});
