# Architecture

Blobgarden is a modular monolith: one Node.js process (or several identical
ones), one PostgreSQL database, and a handful of folders with strict
responsibilities. The aim is that a person can open any file and understand
it without a map. This document is the map anyway.

## Technology

* Node.js with ES modules and plain JavaScript.
* Express 5 for HTTP routing.
* EJS templates rendered on the server.
* PostgreSQL through `pg` (node-postgres), with plain parameterised SQL.
* `express-session` for login sessions, backed by our own small PostgreSQL
  store.
* Node's built-in test runner, against a real PostgreSQL test database.

Password hashing uses `scrypt` from Node's `crypto` module. CSRF protection
is a short hand-written middleware. Neither needs a package.

## Folders

```
src/
  server.js        connects to the database, migrates, loads the catalog,
                   starts the scheduler and listens; the only file that calls listen()
  app.js           builds the Express app: middleware order, routers, error pages
  config.js        settings read from environment variables
  site.js          the game's name and logo
  navigation.js    the main menu entries
  scheduler.js     background jobs: due restocks, expired sessions, old counters
  db/              everything that talks to PostgreSQL
    pool.js        the connection pool and withTransaction()
    migrate.js     applies numbered .sql files once each
    migrations/    the schema, one file per change
    sessions.js    login session storage for express-session
    users.js       SQL for users, including the coin balance
    pets.js        SQL for the pets table
    items.js       SQL for the items table (synced copy of the catalog)
    inventory.js   SQL for the inventory table
    coin-transactions.js  SQL for the coin ledger
    shop-purchases.js     SQL for purchase records
    shop-state.js         SQL for shop schedules
    shop-restock-events.js  SQL for restock history
    shop-stock.js         SQL for limited listings
    daily-supply.js       SQL for daily supply caps
    request-counters.js   SQL for rate-limit counters
    restrictions.js       SQL for administrator-imposed shopping restrictions
    activity-log.js       SQL for the shop activity log
  game/            gameplay rules; no HTTP, no templates
    accounts.js    registration, login, welcome purse and items
    species.js     adoptable creatures (design content)
    items.js       the item catalog (design content) and its sync
    shops.js       the shop catalog: each shop's restock pool (design content)
    restocking.js  restock scheduling and generation
    shop-limits.js every anti-abuse number in one place
    eligibility.js who may buy limited stock
    activity.js    the shop activity log
    shop-admin.js  administrator operations (used by scripts/shop-admin.js)
    inventory.js   granting and taking items
    currency.js    the only place coin balances change; writes the ledger
    purchases.js   buying from a shop
    pets.js        adopting, viewing and feeding pets
  middleware/      request helpers: CSRF, current user, login guard, flash, rate limit
  routes/          one file per area of the site
  views/           EJS templates and partials
  public/          CSS, browser JavaScript, images
scripts/           migrate, reset (development only), and the shop-admin utility
test/              mirrors src/; run with npm test
docs/              this file
```

## Layers and their rules

**Routes** (`src/routes`) read the request, call one game function, and
render a template or redirect. They never contain rules or SQL. If a route
file is doing arithmetic on a stat, the code is in the wrong place.

**Game** (`src/game`) holds every rule: validation, limits, stat changes,
costs. Functions take a database handle plus plain values and return plain
values. When a player breaks a rule they throw a `GameRuleError` with a
message the route can show.

**Database** (`src/db`) holds every SQL statement, one module per table,
each function a single parameterised query. No rules live here.

**Views** (`src/views`) display what they are given. Partials in
`views/partials` provide the shared page frame, the navigation menu, the CSRF
field, and the `picture` partial that shows a placeholder until artwork
exists.

**Middleware** (`src/middleware`) is small and generic: CSRF checking, loading
the logged-in user, redirecting guests away from protected pages, one-shot
flash messages, and a rate limiter backed by the `request_counters` table.

**Browser JavaScript** (`src/public/js`) only enhances pages that already
work without it. `shop.js` refreshes stock counts once a minute; nothing a
player can do depends on it.

## Database access

`src/db/pool.js` opens one `pg.Pool`. Every database function takes a `db`
argument that is either:

* the pool, for a single statement that stands on its own, or
* a client checked out by `withTransaction`, for several statements that
  must succeed or fail together.

Both have the same `query(text, params)` method, so database functions do
not care which they get. The convention in the game layer is:

* **Top-level game functions** (`registerAccount`, `adoptPet`, `feedPet`,
  `purchaseItem`, `syncItemCatalog`) take the pool and open one transaction
  with `withTransaction(pool, async (db) => { ... })`.
* **Helpers that must be atomic with something else** (`spendCoins`,
  `awardCoins`, `takeItem`) take the transaction client and call
  `assertInTransaction`, so passing the pool by mistake fails loudly instead
  of quietly losing atomicity.
* **Single-statement helpers** (`grantItem`, the reads) accept either.

`withTransaction` runs BEGIN, the work, and COMMIT on one connection, rolls
back if the work throws, and always releases the connection. PostgreSQL's
default READ COMMITTED isolation is used throughout; correctness comes from
conditional updates and row locks, described below.

### How concurrent requests stay correct

PostgreSQL may run many requests at once, so every rule that depends on a
current value is enforced inside the statement that changes it:

* Coins: `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1`.
  Zero rows changed means "not enough coins". A balance can never go below
  zero, whatever else is happening.
* Stacks: the inventory upsert's `WHERE` clause refuses to pass 999, and
  removal deletes only `WHERE quantity = n` or subtracts only
  `WHERE quantity > n`.
* Per-account rules (the pet limit, one purchase at a time) lock the
  player's row with `SELECT ... FOR UPDATE` at the start of the transaction,
  so that account's changes run one after the other.
* Uniqueness (usernames, purchase request ids) is a database constraint,
  the final guard when two requests race.

The CHECK constraints on `users.coins`, `inventory.quantity` and the pet
stats are the backstop behind all of this.

### Migrations

The schema lives in `src/db/migrations`. Files run once, in filename order,
and `schema_migrations` records which have run. `runMigrations` takes a
PostgreSQL advisory lock first, so several server processes starting at the
same moment cannot both apply a file. To change the schema, add a new file
such as `002-add-something.sql`; never edit an applied one. Each file runs
in its own transaction, so a broken migration leaves nothing half-applied.

### Sessions

`src/db/sessions.js` implements the four methods express-session needs
(get, set, destroy, touch) on top of the `sessions` table, with the data as
JSONB and the expiry as TIMESTAMPTZ. The scheduler deletes expired rows.
Because sessions are in the database, a login survives a restart and is
shared by every server process.

### Rate limiting

`createRateLimiter({ scope, keyFrom, maxAttempts, windowMs })` counts
requests in fixed windows in the `request_counters` table with a single
upsert, so the count is exact under concurrent requests and shared across
processes. `keyFrom` picks the counted party (the client IP by default, or
the account). Login and registration are limited per IP; shop pages and
purchases per account and per IP (`docs/SHOPS.md`, "Protections"). The
scheduler prunes counters older than a day.

## How a request flows

Take a player submitting the "adopt a pet" form.

1. The browser POSTs the form to `/pets/adopt`.
2. Middleware runs in the order listed in `app.js`: static files, form body
   parsing, the session cookie (loaded from PostgreSQL), the current-user
   loader which fetches the user row, the flash message, then the CSRF
   check.
3. The pets router matches the path and the login guard confirms a user is
   present.
4. The route handler awaits `adoptPet(pool, userId, { name, species })` and
   nothing else.
5. That game function validates the name, checks the species exists, then
   inside one transaction locks the player's row, counts their pets through
   `db/pets.js`, rejects if they are at the limit, and inserts the new pet.
6. `db/pets.js` runs the parameterised INSERT with RETURNING and hands back
   the row.
7. On success the route redirects to the pet's page. On a rule violation it
   re-renders the form with the error message.

Every feature follows the same shape. Reading a route tells you which game
function to open; reading the game function tells you which database
functions it uses.

## Background jobs

`src/scheduler.js` runs inside the web process (`SCHEDULER_ENABLED=false`
turns it off for extra web-only processes). Every 30 seconds it asks each
shop whether a restock is due; every 15 minutes it deletes expired
sessions and old rate-limit counters. Nothing is coordinated in memory:
each job takes the locks it needs in PostgreSQL, so running the scheduler
in several processes is safe and the restock locking is described in
`docs/SHOPS.md`.

## Security basics

* Passwords are hashed with scrypt and a random salt, using the asynchronous
  `crypto.scrypt` so a burst of logins does not block page serving. The hash
  is computed before the database transaction opens.
* Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
* Every state-changing form carries a CSRF token tied to the session.
* All SQL is parameterised. Never build SQL from strings.
* Ownership is checked in the game layer: a pet is always loaded by id *and*
  owner, so a player cannot reach someone else's pet by guessing a number.
* The server is authoritative. Forms submit intentions (adopt this species,
  feed this pet, buy this item); every number is computed on the server.
* Login and registration are rate limited per IP; behind a reverse proxy,
  `TRUST_PROXY` lets `req.ip` and `req.secure` reflect the real client.

## Database

Current tables (see `src/db/migrations/001-initial.sql` for the exact
definitions and comments):

* `users`: account, password hash, coins (CHECK 0 to 1,000,000,000),
  is_admin. Usernames are unique ignoring case.
* `sessions`: login sessions.
* `pets`: owned by a user, with name, species and stats (CHECK 0 to 100).
* `items`: a copy of the item catalog, so inventory rows can use a foreign
  key. Never edited by hand and never deleted from.
* `inventory`: one row per user per item type with a stack quantity
  (CHECK 1 to 999). An emptied stack is deleted.
* `shop_purchases`: completed purchases with the request id that made them.
* `shop_state`, `shop_restock_events`, `shop_stock`, `daily_item_supply`,
  `shopping_restrictions`, `shop_activity_log`: live shop schedules,
  restock history, limited listings, daily caps, restrictions and the
  activity log. See `docs/SHOPS.md`.
* `coin_transactions`: the coin ledger; always sums to the balance.
* `request_counters`: rate-limit windows.
* `schema_migrations`: bookkeeping.

Species and shop *definitions* are not tables. They are JavaScript lists
in `src/game/species.js` and `src/game/shops.js` because they are
hand-edited design content. Live shop state (what is on the shelves right
now, when the next restock is) is in the database, keyed by the shop's id.

### The item catalog

Items are also design content, so they live in JavaScript:
`src/game/items.js` is the authoritative list. At startup `server.js`
calls `syncItemCatalog`, which upserts every catalog entry into the `items`
table and marks any row whose id is no longer in the catalog as retired.
Nothing is deleted, so players keep retired items (shown as keepsakes) and
foreign keys stay valid. Running the sync twice changes nothing.

Item ids are permanent. Once an id has shipped it must never be given to a
different item, because inventory rows refer to it.

An item is in one of three states:

| State        | How it is set                        | Granted? | Usable? |
|--------------|--------------------------------------|----------|---------|
| obtainable   | in the catalog, `obtainable: true`   | yes      | yes     |
| limited-time | in the catalog, `obtainable: false`  | no       | yes     |
| retired      | deleted from the catalog             | no       | no      |

### Feeding, as an example of a transaction

`feedPet` in `src/game/pets.js` runs inside one `withTransaction`:

1. Look up the item in the catalog and check it is food.
2. Load the pet by id *and* owner. Not yours means not found.
3. Work out the new stats, capped at `STAT_MAX`. If no stat the food
   affects would change, the pet refuses it and nothing is consumed.
4. Take one of the item. The SQL in `db/inventory.js` removes the item only
   if the stack holds enough, in a single statement, so two requests racing
   for the last item cannot both succeed.
5. Save the stats.

If any step throws, PostgreSQL rolls the whole thing back and the item is
still in the inventory. The route then redirects (POST, redirect, GET) so a
browser refresh never repeats the feed.

### Coins and shops

`src/game/currency.js` is the only module that changes a balance.
`spendCoins` and `awardCoins` each run one conditional UPDATE in
`db/users.js` and write a ledger row, inside the caller's transaction.
Routes never touch `users.coins`. Future rewards call `awardCoins` with
their own reason.

`purchaseItem` in `src/game/purchases.js` buys from a listing in the
current restock. Inside one transaction it locks the player's row, then
the listing; checks it is
live, in stock and within the per-purchase and per-restock limits; replays
a repeated request id instead of buying twice; refuses if the price the
player saw differs from the real one; then inserts the purchase, takes the
stock, spends the coins and grants the item. Every one of those updates
is conditional in SQL, so stock and coins can never go negative. Any
failure rolls back every step. `docs/SHOPS.md` has the full walk-through.

## Changing the game by hand

* Tunable numbers (starting coins, pet limit, name length, starting stats,
  stack size, purchase quantity) are named constants at the top of the
  relevant `src/game` file.
* Adding a species means adding an object to `species.js`.
* Adding a shop or merchandise, or changing prices, weights, quantities
  and restock timing, means editing `src/game/shops.js`. `docs/SHOPS.md`
  walks through each.
* Adding an item means adding an object to `src/game/items.js` and
  restarting the server. The catalog is validated at startup so a typo
  fails immediately rather than when a player uses the item.
* Adding a menu entry means adding an object to `navigation.js`.
* Adding a page means: a route file (or a handler in an existing one), a
  template, and if it changes state, a game function and a database
  function. Mount the router in `app.js`.
* Changing the schema means a new numbered file in `src/db/migrations`.
* Artwork: put a file in `src/public/images` and set its path in the place
  that owns it. See `src/public/images/README.md`.

## Testing

`npm test` runs everything under `test/` against the database named by
`TEST_DATABASE_URL`. `test/helpers/test-database.js` migrates it once per
process and truncates every table before each test. Game tests call game
functions directly with the pool. Route tests start the real app on a
random port and drive it with `fetch`, keeping cookies like a browser, so
login, CSRF and rate limits are exercised for real. Concurrency tests fire
several requests at once with `Promise.all` and assert on the database
afterwards; nothing is mocked.

## Performance and security notes

What the current design does well, and where its edges are:

* **Correctness under concurrency** rests on PostgreSQL, not on Node:
  conditional updates, row locks in a fixed order, unique constraints and
  CHECK constraints. The load test (`docs/SHOPS.md`) confirms it with
  real overlapping requests. Nothing is coordinated in process memory, so
  several identical Node processes against one database are safe.
* **The single process is the ceiling for page rendering.** EJS rendering
  and scrypt both run on the JavaScript thread (scrypt in the thread
  pool). The load test shows one process comfortably serving a hundred
  active shoppers; past that, run more processes behind the proxy and set
  `SCHEDULER_ENABLED=false` on all but one.
* **Every query is parameterised**, every form is CSRF-protected, every
  state change is server-side, and the browser never supplies a price, a
  quantity limit, an item or a stock level that is trusted. The shown
  price is compared, never used.
* **Sessions and limits are durable** in PostgreSQL, so a restart logs
  nobody out and resets no limit. The cost is one small query per request
  for the session and one per limited request for the counter.
* **Secrets** come only from the environment. The server refuses to start
  in production with the default session secret and refuses to run
  without a database URL.
* **Not done yet:** HTTPS termination (use a reverse proxy and set
  `TRUST_PROXY`), database connection TLS configuration (pass it in the
  connection string when the database is remote; certificate verification
  is never disabled), log shipping, and backups, which are the
  operator's job outside this codebase.
