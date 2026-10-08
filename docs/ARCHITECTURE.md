# Architecture

Blobgarden is a modular monolith: one Node.js process, one SQLite file, and
a handful of folders with strict responsibilities. The aim is that a person
can open any file and understand it without a map. This document is the map
anyway.

## Technology

* Node.js with ES modules and plain JavaScript.
* Express 5 for HTTP routing.
* EJS templates rendered on the server.
* SQLite through `better-sqlite3`, which is synchronous. That keeps database
  code and transactions simple: no `await`, no callbacks.
* `express-session` for login sessions, backed by our own small SQLite store.
* Node's built-in test runner.

Password hashing uses `scrypt` from Node's `crypto` module. CSRF protection is
a short hand-written middleware. Neither needs a package.

## Folders

```
src/
  server.js        starts listening; the only file that calls listen()
  app.js           builds the Express app: middleware order, routers, error pages
  config.js        settings read from environment variables
  site.js          the game's name and logo
  navigation.js    the main menu entries
  db/              everything that talks to SQLite
    connection.js  opens the file and runs migrations
    migrate.js     applies numbered .sql files once each
    migrations/    the schema, one file per change
    sessions.js    login session storage
    users.js       SQL for the users table
    pets.js        SQL for the pets table
    items.js       SQL for the items table (synced copy of the catalog)
    inventory.js   SQL for the inventory table
    coin-transactions.js  SQL for the coin ledger
  game/            gameplay rules; no HTTP, no templates
    accounts.js    registration, login, welcome purse and items
    species.js     adoptable creatures (design content)
    items.js       the item catalog (design content) and its sync
    shops.js       the shop catalog with per-shop prices (design content)
    inventory.js   granting and taking items
    currency.js    the only place coin balances change; writes the ledger
    purchases.js   buying from a shop
    pets.js        adopting, viewing and feeding pets
  middleware/      request helpers: CSRF, current user, login guard
  routes/          one file per area of the site
  views/           EJS templates and partials
  public/          CSS, browser JavaScript, images
test/              mirrors src/; run with npm test
docs/              this file
data/              the SQLite database (ignored by git)
```

## Layers and their rules

**Routes** (`src/routes`) read the request, call one game function, and
render a template or redirect. They never contain rules or SQL. If a route
file is doing arithmetic on a stat, the code is in the wrong place.

**Game** (`src/game`) holds every rule: validation, limits, stat changes,
costs. Functions take the database handle plus plain values and return plain
values. When a player breaks a rule they throw a `GameRuleError` with a
message the route can show. Multi-step changes run inside
`db.transaction(...)`.

**Database** (`src/db`) holds every SQL statement, one module per table,
each function a single parameterised query. No rules live here.

**Views** (`src/views`) display what they are given. Partials in
`views/partials` provide the shared page frame, the navigation menu, the CSRF
field, and the `picture` partial that shows a placeholder until artwork
exists.

**Middleware** (`src/middleware`) is small and generic: CSRF checking, loading
the logged-in user, redirecting guests away from protected pages, and an
in-memory rate limiter that `app.js` places in front of the login and
registration forms.

## How a request flows

Take a player submitting the "adopt a pet" form.

1. The browser POSTs the form to `/pets/adopt`.
2. Middleware runs in the order listed in `app.js`: static files, form body
   parsing, the session cookie, the CSRF check, then the current-user loader
   which reads the user id from the session and fetches the user row.
3. The pets router matches the path and the login guard confirms a user is
   present.
4. The route handler calls `adoptPet(db, userId, { name, species })` and
   nothing else.
5. That game function validates the name, checks the species exists, counts
   the player's pets through `db/pets.js`, and rejects if they are at the
   limit. Inside a transaction it inserts the new pet.
6. `db/pets.js` runs the parameterised INSERT and returns the row.
7. On success the route redirects to the pet's page. On a rule violation it
   re-renders the form with the error message.

Every feature follows the same shape. Reading a route tells you which game
function to open; reading the game function tells you which database
functions it uses.

## Security basics

* Passwords are hashed with scrypt and a random salt. Hashing uses the
  asynchronous `crypto.scrypt`, which runs in Node's thread pool, so a burst
  of logins does not block the single JavaScript thread that serves every
  other page. Because of this, `registerAccount` and `authenticate` are
  `async`, and the hash is computed *before* the database transaction:
  better-sqlite3 transactions must not contain an `await`.
* Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
  Session rows store `expires_at` as an ISO 8601 string; SQL that compares it
  with `datetime('now')` must wrap both sides in `datetime()`, because the
  two text formats do not sort together.
* Login and registration are rate limited per IP address
  (`src/middleware/rate-limit.js`). The limiter keeps its counts in memory,
  which is appropriate for a single-process server.
* Behind a reverse proxy, `TRUST_PROXY` sets Express's `trust proxy` option.
  That is what lets `req.secure` (and therefore the secure cookie) and
  `req.ip` (and therefore rate limiting) reflect the real client.
* Every state-changing form carries a CSRF token tied to the session.
* All SQL is parameterised. Never build SQL from strings.
* Ownership is checked in the game layer: a pet page loads the pet by id
  *and* owner id, so a player cannot view or act on someone else's pet by
  guessing a number.
* The server is authoritative. Forms submit intentions (adopt this species,
  feed this pet); every number is computed on the server.

## Database

The schema lives in `src/db/migrations`. Files run once, in filename order,
and `schema_migrations` records which have run. To change the schema, add a
new file such as `002-add-items.sql`; never edit an applied one.

Current tables:

* `users`: account, password hash, coins. The table requires coins to be
  an integer from 0 to 1,000,000,000 (migration 004 rebuilt it with that
  check).
* `coin_transactions`: the coin ledger. One row per change with a signed
  amount, the balance afterwards, a reason, and for purchases the shop,
  item and quantity. The ledger always sums to the balance.
* `pets`: owned by a user, with name, species and stats (0 to 100).
* `items`: a copy of the item catalog, so inventory rows can use a foreign
  key. Never edited by hand and never deleted from; see below.
* `inventory`: one row per user per item type with a stack `quantity`.
  The table itself requires the quantity to be an integer from 1 to 999
  (migration 003 rebuilt it with that check). An emptied stack is deleted.
* `sessions`: login sessions.
* `schema_migrations`: bookkeeping.

Species and shops are not tables. They are JavaScript lists in
`src/game/species.js` and `src/game/shops.js` because they are hand-edited
design content and nothing in the database needs to reference them by
foreign key. (The ledger stores the shop id as plain text.)

### Migrations that rebuild a table

SQLite cannot add a CHECK constraint to an existing table, so migrations
003 and 004 create a new table, copy the rows, drop the old table and
rename. The migration runner follows SQLite's documented procedure for
this: foreign keys are switched off while migrations run, and each
migration runs `PRAGMA foreign_key_check` before it commits, so a mistake
rolls back instead of leaving orphaned rows.

### The item catalog

Items are also design content, so they live in JavaScript:
`src/game/items.js` is the authoritative list. At startup `server.js`
calls `syncItemCatalog`, which upserts every catalog entry into the `items`
table and marks any row whose id is no longer in the catalog as `retired`.
Nothing is deleted, so players keep retired items (shown as keepsakes) and
foreign keys stay valid. Running the sync twice changes nothing.

Item ids are permanent. Once an id has shipped it must never be given to a
different item, because inventory rows refer to it.

An item is in one of three states, and two flags on the row record them:

| State        | How it is set                        | Granted? | Usable? |
|--------------|--------------------------------------|----------|---------|
| obtainable   | in the catalog, `obtainable: true`   | yes      | yes     |
| limited-time | in the catalog, `obtainable: false`  | no       | yes     |
| retired      | deleted from the catalog             | no       | no      |

"Granted" means any code path that hands items out (`grantItem`): welcome
gifts today, shops and rewards later. "Usable" means the item can be
applied to a pet. Ending a limited-time item is therefore a one-word change
in the catalog; retiring it is a deletion. Both leave player inventories
untouched.

### Stack limits

`MAX_STACK_SIZE` in `src/game/inventory.js` caps how many of one item a
player can hold. Quantities are checked with `Number.isSafeInteger`, so
fractions, strings, and numbers too large to count exactly are refused
before any SQL runs. The cap itself is enforced inside the upsert in
`db/inventory.js` (the `ON CONFLICT ... WHERE` clause), so two grants
arriving together cannot combine to exceed it, and the table's CHECK
constraint is the final backstop. The constant and the constraint are both
999; raising one means a migration to raise the other.

### Feeding, as an example of a transaction

`feedPet` in `src/game/pets.js` runs inside one `db.transaction`:

1. Look up the item in the catalog and check it is food.
2. Load the pet by id *and* owner. Not yours means not found.
3. Refuse if the pet is already full.
4. Take one of the item. The SQL in `db/inventory.js` removes the item only
   if the stack holds enough, in a single statement, so two requests racing
   for the last item cannot both succeed.
5. Apply the effects, capped at `STAT_MAX`, and save the stats.

If any step throws, SQLite rolls the whole thing back and the item is
still in the inventory. The route then redirects (POST, redirect, GET) so a
browser refresh never repeats the feed.

### Coins and shops

`src/game/currency.js` is the only module that changes a balance.
`spendCoins` and `awardCoins` each run one conditional UPDATE in
`db/users.js` (subtract only if the balance covers it; add only if the
ceiling is not exceeded) and write a ledger row. Routes never touch
`users.coins`. Future rewards call `awardCoins` with their own reason.

Shops are design content in `src/game/shops.js`. Each shop lists what it
sells and at what price; items carry no price of their own, so two shops
can price the same thing differently. Stock is unlimited.

`purchaseItem` in `src/game/purchases.js` is the second transaction
example:

1. Look up the shop, then the offer (the item at this shop's price). An
   item that exists but is not on this shop's list is refused.
2. Check the quantity is a safe integer from 1 to `MAX_PURCHASE_QUANTITY`.
3. Total = catalog price times quantity. Nothing from the browser is used
   except the item id and the quantity.
4. Inside one transaction: `spendCoins` (fails if short), then
   `grantItem` (fails if the stack would pass 999). The ledger row records
   shop, item and quantity.

Any failure rolls back both the coins and the items.

Against double submission the shop page carries a one-time purchase token
in the session, printed into every buy form. The buy route accepts a token
once and discards it, so a double-click or a re-sent form gets a polite
refusal instead of a second charge. This works because the session store
and the purchase handler are synchronous: one request runs from session
load to session save without another interleaving. The conditional coin
update is the backstop if that ever changes.

## Changing the game by hand

* Tunable numbers (starting coins, pet limit, name length, starting stats)
  are named constants at the top of the relevant `src/game` file.
* Adding a species means adding an object to `species.js`.
* Adding a shop means adding an object to `src/game/shops.js`; it appears
  in the directory at once. Changing a price means editing the number on
  that shop's merchandise line. Both are validated at startup.
* Adding an item means adding an object to `src/game/items.js` and
  restarting the server. The file's header comment lists the fields; the
  catalog is validated at startup so a typo in a category or effect fails
  immediately rather than when a player uses the item.
* Adding a menu entry means adding an object to `navigation.js`.
* Adding a page means: a route file (or a handler in an existing one), a
  template, and if it changes state, a game function and a database
  function. Mount the router in `app.js`.
* Artwork: put a file in `src/public/images` and set its path in the place
  that owns it (`site.js`, `navigation.js`, `species.js`). See
  `src/public/images/README.md`.

## Testing

`npm test` runs everything under `test/`. Game and database tests use an
in-memory SQLite database. Route tests start the real app on a random port
and drive it with `fetch`, keeping cookies like a browser, so login and CSRF
are exercised for real.
