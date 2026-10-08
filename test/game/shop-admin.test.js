import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resetDatabase } from '../helpers/test-database.js';
import { lowRandom } from '../helpers/fixed-random.js';
import config from '../../src/config.js';
import { registerAccount } from '../../src/game/accounts.js';
import { ensureShopStates, restockShop } from '../../src/game/restocking.js';
import * as admin from '../../src/game/shop-admin.js';
import { findActiveRestriction } from '../../src/db/restrictions.js';
import { findActivityByUser } from '../../src/db/activity-log.js';

const GROCER = 'questionable-grocer';
const run = promisify(execFile);

test('pause, resume and manual restock are recorded with the operator', async () => {
  const db = await resetDatabase();
  await ensureShopStates(db);
  await admin.pauseShop(db, GROCER, 'keeper');
  assert.equal((await admin.listShops(db))[0].paused, true);
  const skipped = await restockShop(db, GROCER, { random: lowRandom });
  assert.equal(skipped.skipped, 'paused', 'the scheduler leaves a paused shop alone');

  const manual = await admin.manualRestock(db, GROCER, 'keeper');
  assert.equal(manual.restocked, true);
  assert.equal(manual.event.triggered_by, 'admin:keeper');
  assert.equal((await admin.shopHistory(db, GROCER))[0].triggered_by, 'admin:keeper');

  await admin.resumeShop(db, GROCER, 'keeper');
  assert.equal((await admin.listShops(db))[0].paused, false);
  const { rows } = await db.query("SELECT kind, details FROM shop_activity_log ORDER BY id");
  assert.deepEqual(rows.map((r) => r.kind), ['admin_pause', 'admin_resume']);
  assert.equal(rows[0].details.by, 'admin:keeper');
});

test('actions need a named operator and a known shop or account', async () => {
  const db = await resetDatabase();
  await ensureShopStates(db);
  await assert.rejects(admin.pauseShop(db, GROCER, undefined), /--by/);
  await assert.rejects(admin.pauseShop(db, GROCER, 'not a valid name!'), /--by/);
  await assert.rejects(admin.pauseShop(db, 'nowhere', 'keeper'), /No shop "nowhere"/);
  await assert.rejects(admin.restrictAccount(db, 'nobody', { reason: 'x' }, 'keeper'), /No account named/);
  await assert.rejects(admin.restrictAccount(db, 'nobody', { reason: '' }, 'keeper'), /No account named|needs a reason/);
});

test('restricting and unrestricting an account is logged and reported', async () => {
  const db = await resetDatabase();
  await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const restriction = await admin.restrictAccount(db, 'Wobble', { reason: 'scripted buying', hours: 2 }, 'keeper');
  assert.equal(restriction.created_by, 'admin:keeper');
  assert.ok(restriction.expires_at > new Date());
  const report = await admin.accountReport(db, 'wobble');
  assert.equal(report.restrictions.length, 1);
  assert.equal(report.activity[0].kind, 'admin_restrict');
  assert.ok(await findActiveRestriction(db, report.user.id));

  assert.equal(await admin.unrestrictAccount(db, 'wobble', 'keeper'), 1);
  assert.equal(await findActiveRestriction(db, report.user.id), null);
  assert.equal((await findActivityByUser(db, report.user.id))[0].kind, 'admin_unrestrict');
});

test('the command-line utility runs against the database', async () => {
  const db = await resetDatabase();
  await ensureShopStates(db);
  await registerAccount(db, { username: 'wobble', password: 'correct horse' });
  const env = { ...process.env, DATABASE_URL: config.testDatabaseUrl };
  const cli = (...args) => run('node', ['scripts/shop-admin.js', ...args], { env, cwd: process.cwd() });

  const shops = await cli('shops');
  assert.match(shops.stdout, /questionable-grocer/);
  const restock = await cli('restock', GROCER, '--by', 'keeper');
  assert.match(restock.stdout, /Restocked questionable-grocer: \d+ listings/);
  const stock = await cli('stock', GROCER);
  assert.match(stock.stdout, /remaining/);
  const restrict = await cli('restrict', 'wobble', '--reason', 'testing', '--hours', '1', '--by', 'keeper');
  assert.match(restrict.stdout, /Restriction #1 on wobble until/);
  const account = await cli('account', 'wobble');
  assert.match(account.stdout, /admin_restrict/);
  const unrestrict = await cli('unrestrict', 'wobble', '--by', 'keeper');
  assert.match(unrestrict.stdout, /Lifted 1 restriction/);

  await assert.rejects(cli('pause', GROCER), /--by/);
  await assert.rejects(cli('nonsense'), /Usage/);
});
