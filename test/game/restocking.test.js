import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, getTestPool } from '../helpers/test-database.js';
import { lowRandom, highRandom, sequenceRandom, seededRandom } from '../helpers/fixed-random.js';
import { createPool } from '../../src/db/pool.js';
import config from '../../src/config.js';
import { findShop, quantityRangeFor, MAX_PRICE } from '../../src/game/shops.js';
import { ensureShopStates, restockShop, restockDueShops, planRestock, shopMerchandise } from '../../src/game/restocking.js';
import { findShopState, setShopPaused } from '../../src/db/shop-state.js';
import { findRestockEvents } from '../../src/db/shop-restock-events.js';
import { findListingsByRestock, findActiveListings } from '../../src/db/shop-stock.js';
import { findDailySupply } from '../../src/db/daily-supply.js';
import { registerAccount } from '../../src/game/accounts.js';

const GROCER = 'questionable-grocer';
const grocer = findShop(GROCER);
const minutes = (n) => n * 60 * 1000;

async function freshShop() {
  const db = await resetDatabase();
  await ensureShopStates(db, new Date('2026-10-08T12:00:00Z'));
  return db;
}

// ----- planning (pure, deterministic) -----

test('a plan has between listingsMin and listingsMax distinct entries, never the whole pool', () => {
  const low = planRestock(grocer, lowRandom);
  assert.equal(low.length, grocer.restock.listingsMin);
  const high = planRestock(grocer, highRandom);
  assert.equal(high.length, grocer.restock.listingsMax);
  assert.ok(high.length <= grocer.restockPool.length / 2, 'most of the pool is always left out, so weights decide');
  assert.equal(new Set(high.map((l) => l.itemId)).size, high.length, 'no item listed twice');
});

test('over many restocks, rare entries appear far less often than common ones', () => {
  // Seeded, so this is exact and repeatable rather than statistical.
  const random = seededRandom(7);
  const appearances = { 'fizzing-pebble': 0, 'pickled-moonbeam': 0, 'unlabelled-jar': 0 };
  const RESTOCKS = 2000;
  for (let i = 0; i < RESTOCKS; i++) {
    for (const planned of planRestock(grocer, random)) appearances[planned.itemId]++;
  }
  const share = (id) => appearances[id] / RESTOCKS;
  // Weights 10 : 3 : 1 and one listing per restock give about 71% : 21% : 7%.
  assert.ok(share('fizzing-pebble') > 0.6, `pebble in ${share('fizzing-pebble')} of restocks`);
  assert.ok(share('pickled-moonbeam') < 0.35, `moonbeam in ${share('pickled-moonbeam')} of restocks`);
  assert.ok(share('unlabelled-jar') < 0.15, `jar in ${share('unlabelled-jar')} of restocks`);
  assert.ok(share('unlabelled-jar') > 0.02, 'the jar does still appear');
  assert.ok(share('fizzing-pebble') > 2 * share('pickled-moonbeam'), 'the rare food is much less common than the treat');
  assert.ok(share('pickled-moonbeam') > 2 * share('unlabelled-jar'), 'and the curiosity rarer still');
});

test('weighted selection follows the configured weights', () => {
  // Pool weights are pebble 10, moonbeam 3, jar 1 (total 14). The first
  // draw is the listing count; the next picks an index by cumulative weight.
  const oneListing = (roll) => planRestock(grocer, sequenceRandom([1, roll]))[0].itemId;
  assert.equal(oneListing(0), 'fizzing-pebble');
  assert.equal(oneListing(9), 'fizzing-pebble');
  assert.equal(oneListing(10), 'pickled-moonbeam');
  assert.equal(oneListing(12), 'pickled-moonbeam');
  assert.equal(oneListing(13), 'unlabelled-jar');
});

test('quantities and prices stay inside each entry\'s ranges over many draws', () => {
  const random = seededRandom(42);
  for (let i = 0; i < 500; i++) {
    for (const planned of planRestock(grocer, random)) {
      const entry = grocer.restockPool.find((e) => e.itemId === planned.itemId);
      const [qLo, qHi] = quantityRangeFor(entry);
      assert.ok(planned.quantity >= qLo && planned.quantity <= qHi, `${planned.itemId} quantity ${planned.quantity}`);
      assert.ok(planned.unitPrice >= entry.price[0] && planned.unitPrice <= entry.price[1], `${planned.itemId} price ${planned.unitPrice}`);
      assert.ok(planned.unitPrice <= MAX_PRICE);
      assert.equal(planned.maxPerPurchase, entry.maxPerPurchase);
    }
  }
});

// ----- restocking against the database -----

test('a due shop is restocked: listings, history and the next time are written', async () => {
  const db = await freshShop();
  const now = new Date('2026-10-08T12:00:00Z');
  const result = await restockShop(db, GROCER, { now, random: highRandom });
  assert.equal(result.restocked, true);
  assert.equal(result.listings.length, grocer.restock.listingsMax);

  const state = await findShopState(db, GROCER);
  assert.equal(state.current_restock_id, result.event.id);
  assert.equal(state.last_restock_at.toISOString(), now.toISOString());
  assert.equal(state.next_restock_at.getTime(), now.getTime() + minutes(grocer.restock.maxMinutes));

  const listings = await findActiveListings(db, GROCER);
  assert.equal(listings.length, grocer.restock.listingsMax);
  for (const listing of listings) {
    assert.equal(listing.remaining_quantity, listing.initial_quantity);
    assert.ok(listing.name, 'item definition is attached');
  }
  const events = await findRestockEvents(db, GROCER);
  assert.equal(events.length, 1);
  assert.equal(events[0].listing_count, grocer.restock.listingsMax);
  assert.equal(events[0].triggered_by, 'scheduler');
  assert.equal(events[0].superseded_at, null);
});

test('the next restock time is random within the configured range', async () => {
  const db = await freshShop();
  const now = new Date('2026-10-08T12:00:00Z');
  const low = await restockShop(db, GROCER, { now, random: lowRandom });
  assert.equal(low.nextRestockAt.getTime(), now.getTime() + minutes(grocer.restock.minMinutes));
  const later = new Date(now.getTime() + minutes(60));
  const mid = await restockShop(db, GROCER, { now: later, random: sequenceRandom([1, 0, 0, 0, 13]) });
  assert.ok(mid.nextRestockAt > later);
  assert.ok(mid.nextRestockAt.getTime() <= later.getTime() + minutes(grocer.restock.maxMinutes));
});

test('a shop that is not due is skipped, and force overrides that', async () => {
  const db = await freshShop();
  const now = new Date('2026-10-08T12:00:00Z');
  await restockShop(db, GROCER, { now, random: lowRandom });
  const tooSoon = await restockShop(db, GROCER, { now: new Date(now.getTime() + minutes(1)), random: lowRandom });
  assert.equal(tooSoon.restocked, false);
  assert.equal(tooSoon.skipped, 'not due');
  const forced = await restockShop(db, GROCER, { now: new Date(now.getTime() + minutes(1)), force: true, triggeredBy: 'admin:wobble', random: lowRandom });
  assert.equal(forced.restocked, true);
  assert.equal(forced.event.triggered_by, 'admin:wobble');
  assert.equal((await findRestockEvents(db, GROCER)).length, 2);
});

test('a paused shop is not restocked by the scheduler', async () => {
  const db = await freshShop();
  await setShopPaused(db, GROCER, true);
  const result = await restockShop(db, GROCER, { random: lowRandom });
  assert.equal(result.skipped, 'paused');
  assert.equal((await shopMerchandise(db, GROCER)).paused, true);
  const forced = await restockShop(db, GROCER, { force: true, triggeredBy: 'admin:wobble', random: lowRandom });
  assert.equal(forced.restocked, true, 'an administrator may still restock it');
});

test('a new restock replaces the old listings but keeps history and purchase records', async () => {
  const db = await freshShop();
  const user = await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const first = await restockShop(db, GROCER, { now: new Date('2026-10-08T12:00:00Z'), random: highRandom });
  const oldListing = first.listings[0];
  // A purchase from the first restock (recorded directly; buying limited
  // stock is the next milestone's job).
  await db.query(
    `INSERT INTO shop_purchases (user_id, shop_id, item_id, quantity, unit_price, total_cost, idempotency_key, request_hash, stock_id, restock_id)
     VALUES ($1, $2, $3, 1, $4, $4, 'key-1', 'hash', $5, $6)`,
    [user.id, GROCER, oldListing.item_id, oldListing.unit_price, oldListing.id, first.event.id],
  );

  const second = await restockShop(db, GROCER, { now: new Date('2026-10-08T12:30:00Z'), random: highRandom });
  assert.notEqual(second.event.id, first.event.id);

  const active = await findActiveListings(db, GROCER);
  assert.ok(active.every((l) => l.restock_id === second.event.id), 'only the new listings are active');
  const old = await findListingsByRestock(db, first.event.id);
  assert.equal(old.length, grocer.restock.listingsMax, 'old listings are kept');
  assert.ok(old.every((l) => l.active === false));

  const events = await findRestockEvents(db, GROCER);
  assert.equal(events.length, 2);
  assert.ok(events.find((e) => e.id === first.event.id).superseded_at !== null);
  assert.equal(events.find((e) => e.id === second.event.id).superseded_at, null);

  const { rows } = await db.query('SELECT stock_id, restock_id FROM shop_purchases');
  assert.deepEqual(rows, [{ stock_id: oldListing.id, restock_id: first.event.id }], 'the purchase still points at the old listing');
});

test('concurrent workers restock a due shop exactly once', async () => {
  const db = await freshShop();
  const now = new Date('2026-10-08T12:00:00Z');
  // Five separate pool connections, all overlapping on the same shop.
  const results = await Promise.all(Array.from({ length: 5 }, () => restockShop(db, GROCER, { now, random: lowRandom })));
  assert.equal(results.filter((r) => r.restocked).length, 1);
  assert.equal((await findRestockEvents(db, GROCER)).length, 1);
  assert.equal((await findActiveListings(db, GROCER)).length, grocer.restock.listingsMin);
});

test('workers in different processes (separate pools) also restock once', async () => {
  const db = await freshShop();
  const other = createPool(config.testDatabaseUrl);
  try {
    const now = new Date('2026-10-08T12:00:00Z');
    const results = await Promise.all([
      restockShop(db, GROCER, { now, random: lowRandom }),
      restockShop(other, GROCER, { now, random: lowRandom }),
      restockShop(db, GROCER, { now, random: lowRandom }),
      restockShop(other, GROCER, { now, random: lowRandom }),
    ]);
    assert.equal(results.filter((r) => r.restocked).length, 1);
    assert.equal((await findRestockEvents(db, GROCER)).length, 1);
  } finally {
    await other.end();
  }
});

test('a missed restock after downtime is made up exactly once, never backlogged', async () => {
  const db = await freshShop();
  const scheduledFor = new Date('2026-10-08T12:00:00Z');
  await restockShop(db, GROCER, { now: scheduledFor, random: lowRandom }); // next due 12:08
  const backUp = new Date('2026-10-08T15:00:00Z'); // hours late
  const results = await restockDueShops(db, { now: backUp, random: lowRandom });
  assert.equal(results.filter((r) => r.restocked).length, 1);
  const again = await restockDueShops(db, { now: backUp, random: lowRandom });
  assert.equal(again.filter((r) => r.restocked).length, 0, 'nothing else is due');
  const state = await findShopState(db, GROCER);
  assert.equal(state.next_restock_at.getTime(), backUp.getTime() + minutes(grocer.restock.minMinutes), 'scheduled from now, not from the missed time');
  assert.equal((await findRestockEvents(db, GROCER)).length, 2);
});

test('state survives a restart: ensureShopStates never resets an existing schedule', async () => {
  const db = await freshShop();
  const first = await restockShop(db, GROCER, { now: new Date('2026-10-08T12:00:00Z'), random: highRandom });
  // A "restarted" process runs startup again and uses its own pool.
  const restarted = createPool(config.testDatabaseUrl);
  try {
    await ensureShopStates(restarted, new Date('2026-10-08T12:01:00Z'));
    const state = await findShopState(restarted, GROCER);
    assert.equal(state.current_restock_id, first.event.id);
    assert.equal(state.next_restock_at.toISOString(), '2026-10-08T12:18:00.000Z');
    assert.equal((await findActiveListings(restarted, GROCER)).length, grocer.restock.listingsMax, 'stock is still there');
    const notDue = await restockShop(restarted, GROCER, { now: new Date('2026-10-08T12:01:00Z'), random: lowRandom });
    assert.equal(notDue.skipped, 'not due');
  } finally {
    await restarted.end();
  }
});

test('daily supply caps limit how many copies restocks create per UTC day', async () => {
  const db = await freshShop();
  // Force the jar (cap 4) into every restock, two copies at a time.
  const jarOnly = {
    ...grocer,
    restock: { ...grocer.restock, listingsMin: 1, listingsMax: 1 },
    restockPool: grocer.restockPool.filter((e) => e.itemId === 'unlabelled-jar').map((e) => ({ ...e, quantity: [2, 2] })),
  };
  const results = [];
  for (let i = 0; i < 4; i++) {
    const now = new Date(`2026-10-08T1${i}:00:00Z`);
    results.push(await restockConfigured(db, jarOnly, { now, random: highRandom }));
  }
  const created = results.map((r) => r.listings.reduce((sum, l) => sum + l.initial_quantity, 0));
  assert.deepEqual(created, [2, 2, 0, 0], 'two restocks fill the cap, later ones get nothing');
  assert.equal(await findDailySupply(db, 'unlabelled-jar', '2026-10-08'), 4);

  const nextDay = await restockConfigured(db, jarOnly, { now: new Date('2026-10-09T00:30:00Z'), random: highRandom });
  assert.equal(nextDay.listings[0].initial_quantity, 2, 'the cap resets with the UTC day');
});

test('simultaneous restocks cannot exceed a daily supply cap together', async () => {
  const db = await freshShop();
  const other = createPool(config.testDatabaseUrl);
  try {
    const jarOnly = {
      ...grocer,
      restock: { ...grocer.restock, listingsMin: 1, listingsMax: 1 },
      restockPool: grocer.restockPool.filter((e) => e.itemId === 'unlabelled-jar').map((e) => ({ ...e, quantity: [3, 3] })),
    };
    // Make a second shop share the item so two shops restock at once.
    await db.query("INSERT INTO shop_state (shop_id, next_restock_at) VALUES ('second-shop', now())");
    const now = new Date('2026-10-08T12:00:00Z');
    const results = await Promise.all([
      restockConfigured(db, jarOnly, { now, random: highRandom }),
      restockConfigured(other, { ...jarOnly, id: 'second-shop' }, { now, random: highRandom }),
      restockConfigured(db, { ...jarOnly, id: 'second-shop' }, { now: new Date(now.getTime() + 1), force: true, random: highRandom }),
      restockConfigured(other, jarOnly, { now: new Date(now.getTime() + 1), force: true, random: highRandom }),
    ]);
    const created = results.filter((r) => r.restocked).flatMap((r) => r.listings).reduce((sum, l) => sum + l.initial_quantity, 0);
    assert.ok(created <= 4, `created ${created}, cap is 4`);
    assert.equal(await findDailySupply(db, 'unlabelled-jar', '2026-10-08'), created);
  } finally {
    await other.end();
  }
});

// Runs restockShop with a modified shop definition in place of the catalog
// entry, so tests can force particular pool contents.
async function restockConfigured(db, shopDefinition, options) {
  const { restockShopWithDefinition } = await import('../../src/game/restocking.js');
  return restockShopWithDefinition(db, shopDefinition, { force: true, ...options });
}
