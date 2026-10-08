# Blobgarden

An original browser-based virtual pet game in the spirit of the early-2000s
web. Server-rendered pages, plain forms and links, SQLite on disk, and no
build step.

## Requirements

* Node.js 22 or newer (required by better-sqlite3)
* npm

## Installation

```
npm install
```

This compiles the `better-sqlite3` native module, which needs a C++ toolchain
on your machine. Prebuilt binaries exist for common platforms so this usually
just works.

## Running the game

```
npm start
```

Then open http://localhost:3000.

For development, `npm run dev` restarts the server whenever a file changes.

The database file is created automatically at `data/game.sqlite` on first
start. Delete that file to start over with a clean world.

## Settings

Every setting has a development default and can be overridden with an
environment variable:

| Variable         | Default                          | Purpose                               |
|------------------|----------------------------------|---------------------------------------|
| `PORT`           | `3000`                           | Port the web server listens on        |
| `DATABASE_PATH`  | `data/game.sqlite`               | Where the SQLite file lives           |
| `SESSION_SECRET` | a fixed development value        | Signs login cookies. Set it in production. |
| `NODE_ENV`       | unset                            | Set to `production` to require a real secret and secure cookies |
| `TRUST_PROXY`    | unset                            | Set to `1` (or another hop count) when a reverse proxy sits in front of the game |

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
per 15 minutes, 5 registrations per hour). The counters live in memory and
reset when the server restarts.

## Tests

```
npm test
```

Tests use Node's built-in test runner and an in-memory database, so they need
no setup and leave nothing behind.

## Adding items

Items are defined in `src/game/items.js`. Add an object to the list, give
it an id that has never been used before, and restart the server; the
database copy is updated automatically. See the comment at the top of that
file for the fields and `docs/ARCHITECTURE.md` for how the sync works.

To stop handing out a limited-time item, set `obtainable: false` on it.
Players who already own one can still use it. To remove an item from the
game entirely, delete its entry; owners keep it as a keepsake.

## Adding your own artwork

See `src/public/images/README.md`. Every picture in the game falls back to a
labelled placeholder box until you provide a file, so you can drop in art
whenever it is ready.

## Project layout

See `docs/ARCHITECTURE.md` for how the code is organised and how a request
travels through it.
