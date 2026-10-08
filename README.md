# Blobgarden

An original browser-based virtual pet game in the spirit of the early-2000s
web. Server-rendered pages, plain forms and links, SQLite on disk, and no
build step.

## Requirements

* Node.js 20 or newer
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

## Tests

```
npm test
```

Tests use Node's built-in test runner and an in-memory database, so they need
no setup and leave nothing behind.

## Adding your own artwork

See `src/public/images/README.md`. Every picture in the game falls back to a
labelled placeholder box until you provide a file, so you can drop in art
whenever it is ready.

## Project layout

See `docs/ARCHITECTURE.md` for how the code is organised and how a request
travels through it.
