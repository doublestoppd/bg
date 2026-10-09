// Administrator utility for the shops: `npm run shop-admin -- <command>`.
// Runs on the server with the game's database credentials; that access is
// the authorisation. Every action that changes something needs --by <name>
// and is recorded with that name.
//
//   shops                              every shop, paused or not, last and next restock
//   stock <shop>                       current listings and remaining quantities
//   history <shop> [--limit N]         recent restock events
//   purchases <shop> [--limit N]       recent purchases in a shop
//   account <username>                 an account's restrictions, purchases and logged activity
//   suspicious [--hours N]             accounts with the most logged shop events
//   pause <shop> --by <name>           stop automatic restocks
//   resume <shop> --by <name>          allow them again
//   restock <shop> --by <name>         restock now (obeys locks, caps and the catalog)
//   restrict <username> --reason "..." [--hours N] --by <name>
//                                      stop an account buying limited stock
//   unrestrict <username> --by <name>  lift its restrictions
import { parseArgs } from 'node:util';
import { requireDatabaseUrl } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import * as admin from '../src/game/shop-admin.js';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    by: { type: 'string' },
    reason: { type: 'string' },
    hours: { type: 'string' },
    limit: { type: 'string' },
  },
});
const [command, target] = positionals;
// Options arrive as strings; undefined means "use the default".
const number = (value, fallback) => (value === undefined ? fallback : Number(value));
const limit = number(options.limit, undefined);

const commands = {
  shops: async (pool) => table(await admin.listShops(pool)),
  stock: async (pool) => {
    const { state, listings } = await admin.shopStock(pool, need(target, 'shop'));
    console.log(state ? `paused: ${state.paused}, last restock: ${when(state.last_restock_at)}, next: ${when(state.next_restock_at)}, restock id: ${state.current_restock_id}` : 'no state row yet (server has not started)');
    table(listings.map((l) => ({ id: l.id, item: l.item_id, price: l.unit_price, remaining: `${l.remaining_quantity}/${l.initial_quantity}` })));
  },
  history: async (pool) => table(await admin.shopHistory(pool, need(target, 'shop'), limit)),
  purchases: async (pool) => table(await admin.shopPurchases(pool, need(target, 'shop'), limit)),
  account: async (pool) => {
    const report = await admin.accountReport(pool, need(target, 'username'), limit);
    console.log(`#${report.user.id} ${report.user.username}, ${report.user.coins} coins, registered ${when(report.user.created_at)}`);
    console.log('\nRestrictions:'); table(report.restrictions);
    console.log('\nPurchases:'); table(report.purchases.map((p) => ({ id: p.id, shop: p.shop_id, item: p.item_id, qty: p.quantity, price: p.unit_price, listing: p.stock_id, at: when(p.created_at) })));
    console.log('\nActivity:'); table(report.activity.map((a) => ({ at: when(a.created_at), kind: a.kind, shop: a.shop_id, listing: a.stock_id, ip: a.ip, details: JSON.stringify(a.details) })));
  },
  suspicious: async (pool) => table((await admin.suspiciousAccounts(pool, number(options.hours, 24), limit)).map((row) => ({ ...row, by_kind: JSON.stringify(row.by_kind) }))),
  pause: async (pool) => { await admin.pauseShop(pool, need(target, 'shop'), options.by); console.log(`Paused ${target}.`); },
  resume: async (pool) => { await admin.resumeShop(pool, need(target, 'shop'), options.by); console.log(`Resumed ${target}.`); },
  restock: async (pool) => {
    const result = await admin.manualRestock(pool, need(target, 'shop'), options.by);
    console.log(result.restocked ? `Restocked ${target}: ${result.listings.length} listings (event ${result.event.id}).` : `Not restocked: ${result.skipped}.`);
  },
  restrict: async (pool) => {
    const r = await admin.restrictAccount(pool, need(target, 'username'), { reason: options.reason, hours: number(options.hours, null) }, options.by);
    console.log(`Restriction #${r.id} on ${target}${r.expires_at ? ` until ${when(r.expires_at)}` : ' until lifted'}.`);
  },
  unrestrict: async (pool) => console.log(`Lifted ${await admin.unrestrictAccount(pool, need(target, 'username'), options.by)} restriction(s) on ${target}.`),
};

if (!commands[command]) {
  console.error('Usage: npm run shop-admin -- <command> [target] [--by name] [--reason "..."] [--hours N] [--limit N]');
  console.error('Commands: ' + Object.keys(commands).join(', '));
  process.exit(1);
}

const pool = createPool(requireDatabaseUrl());
try {
  await commands[command](pool);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function need(value, what) {
  if (!value) throw new Error(`This command needs a ${what}`);
  return value;
}

function when(date) {
  return date ? new Date(date).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-';
}

function table(rows) {
  if (rows.length === 0) console.log('(none)');
  else console.table(rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? when(v) : v]))));
}
