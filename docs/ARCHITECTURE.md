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
  game/            gameplay rules; no HTTP, no templates
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
the logged-in user, and redirecting guests away from protected pages.

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

* Passwords are hashed with scrypt and a random salt.
* Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
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

* `users`: account, password hash, coins.
* `pets`: owned by a user, with name, species and stats (0 to 100).
* `sessions`: login sessions.
* `schema_migrations`: bookkeeping.

Species are not a table. They are a JavaScript list in `src/game/species.js`
because they are hand-edited design content.

## Changing the game by hand

* Tunable numbers (starting coins, pet limit, name length, starting stats)
  are named constants at the top of the relevant `src/game` file.
* Adding a species means adding an object to `species.js`.
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
