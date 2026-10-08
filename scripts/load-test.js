// A repeatable load test for the shops: `npm run load-test -- --url http://localhost:3999`.
//
// Run the server first with TRUST_PROXY=1 (each simulated player presents
// its own X-Forwarded-For address, as real players would have their own)
// against a development database. This script needs DATABASE_URL too: it
// creates the players and gives them coins directly, forces restocks
// mid-run, and checks consistency afterwards. Never point it at production.
//
// Phases:
//   1. browse and buy: every player refreshes the shop every 1.5 to 3 s and
//      buys something most of the time, while a restock replaces the
//      shelves every few seconds.
//   2. rush: one scarce listing with a single copy; every player buys at once.
//   3. rapid refresh: a few players reload about 8 times a second, past the
//      per-minute allowance, to show the rate limit answering.
//   4. consistency: stock sold equals purchases recorded, every ledger sums
//      to its balance, inventories match purchases, nothing negative.
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { requireDatabaseUrl } from '../src/config.js';
import { createPool, withTransaction } from '../src/db/pool.js';
import { registerAccount, STARTING_COINS, WELCOME_ITEMS } from '../src/game/accounts.js';
import { awardCoins } from '../src/game/currency.js';
import { ensureShopStates, restockShop, restockShopWithDefinition } from '../src/game/restocking.js';
import { findShop } from '../src/game/shops.js';

const { values: options } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3999' },
    players: { type: 'string', default: '30' },
    seconds: { type: 'string', default: '20' },
    'restock-every': { type: 'string', default: '5' },
  },
});
const BASE = options.url.replace(/\/$/, '');
const PLAYERS = Number(options.players);
const SECONDS = Number(options.seconds);
const RESTOCK_EVERY_MS = Number(options['restock-every']) * 1000;
const SHOP = 'questionable-grocer';

const pool = createPool(requireDatabaseUrl());
const stats = { requests: {}, purchases: { ok: 0, refused: {}, errors: 0 }, latencies: {} };

function record(label, status, ms) {
  stats.requests[label] = stats.requests[label] || {};
  stats.requests[label][status] = (stats.requests[label][status] || 0) + 1;
  (stats.latencies[label] = stats.latencies[label] || []).push(ms);
}

// A simulated player: own cookie jar, own address.
function makePlayer(index, username) {
  const ip = `203.0.113.${(index % 250) + 1}`;
  let cookie = '';
  async function request(path, { method = 'GET', form } = {}, label = path) {
    const headers = { cookie, 'x-forwarded-for': ip };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const started = performance.now();
    const response = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    const text = await response.text();
    record(label, response.status, performance.now() - started);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, text };
  }
  return { index, username, ip, request };
}

async function logIn(player) {
  const page = await player.request('/login', {}, 'GET /login');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const result = await player.request('/login', { method: 'POST', form: { _csrf: csrf, username: player.username, password: 'load-test-pass' } }, 'POST /login');
  if (result.status !== 302) throw new Error(`${player.username} could not log in (${result.status})`);
}

// Reads the shop page and returns its buy forms.
async function shopForms(player) {
  const page = await player.request(`/shops/${SHOP}`, {}, 'GET /shops/:id');
  if (page.status !== 200) return { status: page.status, forms: [] };
  const csrf = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const forms = [];
  const re = /name="request_id" value="([^"]+)">\s*<input type="hidden" name="(item|listing)" value="([^"]+)">\s*<input type="hidden" name="shown_price" value="(\d+)">[\s\S]*?max="(\d+)"/g;
  let m;
  while ((m = re.exec(page.text))) forms.push({ requestId: m[1], kind: m[2], id: m[3], price: Number(m[4]), max: Number(m[5]), csrf });
  return { status: 200, forms };
}

async function buy(player, form, quantity = 1) {
  const body = { _csrf: form.csrf, request_id: form.requestId, shown_price: String(form.price), quantity: String(quantity) };
  body[form.kind] = form.id;
  const result = await player.request(`/shops/${SHOP}/buy`, { method: 'POST', form: body }, 'POST /shops/:id/buy');
  if (result.status === 302) stats.purchases.ok++;
  else if (result.status === 400 || result.status === 429) {
    const reason = (result.text.match(/notice-error"><p>([^<]+)</) || [, 'rate limited'])[1].replace(/\d+/g, 'N').slice(0, 60);
    stats.purchases.refused[reason] = (stats.purchases.refused[reason] || 0) + 1;
  } else stats.purchases.errors++;
  return result.status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; };

async function main() {
  console.log(`Load test against ${BASE}: ${PLAYERS} players for ${SECONDS}s, restock every ${RESTOCK_EVERY_MS / 1000}s\n`);
  await ensureShopStates(pool);

  // --- players ---
  const stamp = Date.now().toString(36);
  const players = [];
  for (let i = 0; i < PLAYERS; i++) {
    const username = `load_${stamp}_${i}`;
    const user = await registerAccount(pool, { username, password: 'load-test-pass' });
    await withTransaction(pool, (tx) => awardCoins(tx, user.id, 5000, { reason: 'reward' }));
    players.push({ ...makePlayer(i, username), id: user.id });
  }
  await Promise.all(players.map(logIn));
  console.log(`Created and logged in ${players.length} players.`);

  // --- phase 1: browse and buy with restocks ---
  await restockShop(pool, SHOP, { force: true, triggeredBy: 'admin:load-test' });
  let running = true;
  let restocks = 0;
  const restocker = (async () => {
    while (running) {
      await sleep(RESTOCK_EVERY_MS);
      if (!running) break;
      const result = await restockShop(pool, SHOP, { force: true, triggeredBy: 'admin:load-test' });
      if (result.restocked) restocks++;
    }
  })();
  const deadline = Date.now() + SECONDS * 1000;
  await Promise.all(players.map(async (player) => {
    while (Date.now() < deadline) {
      const { forms } = await shopForms(player);
      if (forms.length && Math.random() < 0.7) {
        const form = forms[Math.floor(Math.random() * forms.length)];
        await buy(player, form, 1 + Math.floor(Math.random() * Math.min(form.max, 3)));
      }
      await sleep(1500 + Math.random() * 1500);
    }
  }));
  running = false;
  await restocker;
  console.log(`Phase 1 done: ${restocks} restocks happened while players were buying.`);

  // --- phase 2: rush for one copy ---
  const grocer = findShop(SHOP);
  const rare = grocer.restockPool.find((e) => e.itemId === 'pickled-moonbeam');
  const scarce = await restockShopWithDefinition(pool, {
    ...grocer,
    restock: { ...grocer.restock, listingsMin: 1, listingsMax: 1 },
    restockPool: [{ ...rare, quantity: [1, 1], price: [60, 60], maxPerPurchase: 1, maxPerRestock: 1, dailySupplyCap: undefined }],
  }, { force: true, triggeredBy: 'admin:load-test' });
  const listing = scarce.listings[0];
  const rushForms = await Promise.all(players.map(async (player) => ({ player, form: (await shopForms(player)).forms.find((f) => f.kind === 'listing' && f.id === String(listing.id)) })));
  const rushStarted = performance.now();
  const rushResults = await Promise.all(rushForms.filter((r) => r.form).map(({ player, form }) => buy(player, form, 1)));
  const winners = rushResults.filter((s) => s === 302).length;
  console.log(`Phase 2 done: ${rushResults.length} players rushed one copy in ${Math.round(performance.now() - rushStarted)} ms; ${winners} got it.`);

  // --- phase 3: rapid refresh ---
  const refreshers = players.slice(0, 3);
  let limited = 0;
  const RELOADS = 80;
  await Promise.all(refreshers.map(async (player) => {
    for (let i = 0; i < RELOADS; i++) {
      const { status } = await shopForms(player);
      if (status === 429) limited++;
      await sleep(120);
    }
  }));
  console.log(`Phase 3 done: ${refreshers.length} players reloaded ${RELOADS} times each at about 8/s; ${limited} reloads were rate limited.`);

  // --- phase 4: consistency ---
  const problems = [];
  const { rows: stock } = await pool.query(`
    SELECT s.id, s.initial_quantity, s.remaining_quantity, COALESCE(SUM(p.quantity), 0)::int AS sold
    FROM shop_stock s LEFT JOIN shop_purchases p ON p.stock_id = s.id
    WHERE s.shop_id = $1 GROUP BY s.id`, [SHOP]);
  for (const row of stock) {
    if (row.remaining_quantity < 0) problems.push(`listing ${row.id} negative`);
    if (row.initial_quantity - row.remaining_quantity !== row.sold) problems.push(`listing ${row.id}: ${row.initial_quantity - row.remaining_quantity} left the shelf but ${row.sold} recorded`);
  }
  const ids = players.map((p) => p.id);
  const { rows: ledgers } = await pool.query(`
    SELECT u.id, u.coins, COALESCE(SUM(t.amount), 0)::bigint AS ledger
    FROM users u LEFT JOIN coin_transactions t ON t.user_id = u.id WHERE u.id = ANY($1) GROUP BY u.id`, [ids]);
  for (const row of ledgers) {
    if (row.coins < 0) problems.push(`user ${row.id} negative coins`);
    if (Number(row.ledger) !== row.coins) problems.push(`user ${row.id}: ledger ${row.ledger} vs balance ${row.coins}`);
  }
  const { rows: inventories } = await pool.query(`
    SELECT user_id, item_id, SUM(quantity)::int AS bought FROM shop_purchases WHERE user_id = ANY($1) GROUP BY user_id, item_id`, [ids]);
  const { rows: stacks } = await pool.query('SELECT user_id, item_id, quantity FROM inventory WHERE user_id = ANY($1)', [ids]);
  for (const row of inventories) {
    const welcome = (WELCOME_ITEMS.find((w) => w.itemId === row.item_id) || { quantity: 0 }).quantity;
    const stack = stacks.find((s) => s.user_id === row.user_id && s.item_id === row.item_id);
    if (!stack || stack.quantity !== row.bought + welcome) problems.push(`user ${row.user_id} ${row.item_id}: bought ${row.bought} (+${welcome} welcome) but holds ${stack ? stack.quantity : 0}`);
  }
  const { rows: [{ dup }] } = await pool.query('SELECT COUNT(*)::int AS dup FROM (SELECT user_id, idempotency_key FROM shop_purchases GROUP BY 1, 2 HAVING COUNT(*) > 1) d');
  if (dup > 0) problems.push(`${dup} duplicated request ids`);

  // --- report ---
  console.log('\nRequests (status: count) and latency in ms:');
  for (const [label, byStatus] of Object.entries(stats.requests)) {
    const l = stats.latencies[label];
    console.log(`  ${label.padEnd(22)} ${JSON.stringify(byStatus).padEnd(40)} p50 ${Math.round(percentile(l, 0.5))}  p95 ${Math.round(percentile(l, 0.95))}  max ${Math.round(Math.max(...l))}  n=${l.length}`);
  }
  console.log(`\nPurchases: ${stats.purchases.ok} succeeded, ${Object.values(stats.purchases.refused).reduce((a, b) => a + b, 0)} refused, ${stats.purchases.errors} server errors`);
  for (const [reason, count] of Object.entries(stats.purchases.refused).sort((a, b) => b[1] - a[1])) console.log(`  ${count}  ${reason}`);
  console.log(`\nRush: ${winners === 1 ? 'exactly one winner' : `WRONG: ${winners} winners`}`);
  console.log(`Consistency: ${problems.length === 0 ? 'stock, ledgers, inventories and request ids all agree' : problems.join('\n  ')}`);
  console.log(`\nStarting coins ${STARTING_COINS} + 5000 awarded per player; players were not deleted (usernames load_${stamp}_*).`);
  await pool.end();
  process.exitCode = problems.length === 0 && winners === 1 && stats.purchases.errors === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
