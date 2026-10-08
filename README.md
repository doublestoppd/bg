# Blobgarden

An original browser-based virtual pet game in the spirit of the early-2000s
web. Server-rendered pages, plain forms and links, PostgreSQL for all game
data, and no build step.

## Requirements

* Node.js 22 or newer
* PostgreSQL 14 or newer (16 is what development uses)
* npm

## Installation

```
npm install
```

### Create the databases

The game needs one database to run and a second, throwaway one for the
test suite. With PostgreSQL running locally, as a superuser:

```
psql -U postgres <<'SQL'
CREATE ROLE blobgarden LOGIN PASSWORD 'blobgarden';
CREATE DATABASE blobgarden_dev OWNER blobgarden;
CREATE DATABASE blobgarden_test OWNER blobgarden;
SQL
```

Use your own password outside a local development machine.

### Configure

```
cp .env.example .env
```

Edit `.env` so `DATABASE_URL` and `TEST_DATABASE_URL` match the databases
you created. Every npm script loads `.env` automatically; nothing in it is
committed to git.

### Create the tables

```
npm run db:migrate
```

This applies every file in `src/db/migrations` that has not been applied
yet, in order. The server also runs it on startup, so a deploy that adds a
migration needs no separate step. It is safe to run any number of times.

## Running the game

```
npm start
```

Then open http://localhost:3000. For development, `npm run dev` restarts
the server whenever a file changes.

## Settings

Every setting is read from the environment (see `.env.example`):

| Variable            | Default                          | Purpose                               |
|---------------------|----------------------------------|---------------------------------------|
| `DATABASE_URL`      | none, required                   | PostgreSQL connection string          |
| `TEST_DATABASE_URL` | none, required for `npm test`    | A separate database the tests wipe    |
| `PORT`              | `3000`                           | Port the web server listens on        |
| `SESSION_SECRET`    | a fixed development value        | Signs login cookies. Set it in production. |
| `NODE_ENV`          | unset                            | Set to `production` to require a real secret and secure cookies |
| `TRUST_PROXY`       | unset                            | Set to `1` (or another hop count) when a reverse proxy sits in front of the game |
| `SCHEDULER_ENABLED` | `true`                           | Run restocks and housekeeping in this process. Set `false` on extra web-only processes. |
| `RESTOCK_CHECK_INTERVAL_MS` | `30000`                  | How often the scheduler checks whether a shop is due a restock |

The server refuses to start without `DATABASE_URL`, and in production it
refuses the default session secret.

## Tests

```
npm test
```

Tests use Node's built-in test runner and a real PostgreSQL database named
by `TEST_DATABASE_URL`. Every test starts by emptying that database, so it
must never point at the development or production database (the helper
refuses if the two URLs match). Test files run one at a time because they
share the database; tests that check concurrency open several connections
inside one test.

## Load testing

```
TRUST_PROXY=1 PORT=3999 npm start          # in one terminal
npm run load-test -- --url http://localhost:3999 --players 30 --seconds 20
```

The script creates throwaway players in the development database, has
them browse and buy while restocks replace the shelves, stages a rush for
a single scarce copy, hammers the page past the rate limit, then checks
that stock, ledgers, inventories and request ids all agree. It prints
request counts, latencies and the result. `TRUST_PROXY=1` is needed
because each simulated player sends its own forwarded address, as real
players would have their own. Never run it against production: it
creates accounts and forces restocks. `docs/SHOPS.md` has measured
results and what they do and do not show.

## Resetting the development database

```
npm run db:reset -- --yes
```

Drops every table in `DATABASE_URL` and re-runs the migrations. It refuses
to run when `NODE_ENV=production`. There is no undo.

## Running behind a reverse proxy

In production the login cookie is marked `Secure`, so the browser only sends
it over HTTPS. When nginx, Caddy or a similar proxy terminates HTTPS and
forwards plain HTTP to Node, the game cannot tell the original request was
secure unless it trusts the proxy's `X-Forwarded-Proto` header. Set
`TRUST_PROXY=1` for one proxy hop (or the number of hops you have). The same
setting makes rate limiting see each visitor's real address instead of the
proxy's. Without it, nobody can log in to a production deployment behind a
proxy, and every visitor shares one rate-limit bucket.

Login and registration are rate limited per IP address (10 login attempts
per 15 minutes, 5 registrations per hour). The counters live in the
database, so they survive restarts and are shared by every server process.

## Deploying

1. Provision PostgreSQL and create a database and role for the game.
2. Set `DATABASE_URL`, a long random `SESSION_SECRET`, `NODE_ENV=production`,
   and `TRUST_PROXY` if a proxy is in front.
3. `npm install --omit=dev` and `npm start`. Startup applies migrations,
   loads the item catalog, and begins listening. Run one process to start
   with; several processes against the same database are supported because
   sessions, rate limits and all game state live in PostgreSQL.
4. Stop the server with SIGTERM; it finishes requests in flight and closes
   its connections.

## Adding items

Items are defined in `src/game/items.js`. Add an object to the list, give
it an id that has never been used before, and restart the server; the
database copy is updated automatically. See the comment at the top of that
file for the fields and `docs/ARCHITECTURE.md` for how the sync works.

To stop handing out a limited-time item, set `obtainable: false` on it.
Players who already own one can still use it. To remove an item from the
game entirely, delete its entry; owners keep it as a keepsake.

## Shops

Shops live in `src/game/shops.js`: always-available essentials at fixed
prices, plus a pool of limited merchandise that random restocks draw from.
`docs/SHOPS.md` explains the configuration, how restocks and purchases
work, the anti-abuse protections, and how to add a shop, change a price,
or change how often something appears.

Administrators use `npm run shop-admin -- <command>` on the server to
inspect stock and history, pause or restock a shop, and restrict accounts.
Run it without a command to see the list. `docs/SHOPS.md` ("Operations")
has the details.

## Adding your own artwork

See `src/public/images/README.md`. Every picture in the game falls back to a
labelled placeholder box until you provide a file, so you can drop in art
whenever it is ready.

## Project layout

See `docs/ARCHITECTURE.md` for how the code is organised and how a request
travels through it, `docs/ECONOMY.md` for coins, prices and scarcity, and
`docs/SHOPS.md` for shops, restocks, purchasing and operations.
