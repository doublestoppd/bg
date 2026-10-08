# Shops

How Blobgarden's NPC shops are defined, stocked, bought from, protected,
and operated. Written for a JavaScript developer who is not a database
specialist.

## The idea

Shops work like the classic early-2000s pet-site shops. Each shop always
has a few **essentials** at fixed prices, and every so often it **restocks**:
a random assortment of limited merchandise appears on the shelves at
random prices, shared by every player, first come first served, until it
sells out or the next restock replaces it. There is no haggling, no lottery
and no reservation: whoever's purchase commits first gets the item.

## Where things live

| What | Where |
|---|---|
| Shop definitions, merchandise, prices, weights, limits | `src/game/shops.js` (JavaScript, hand-edited) |
| Restock rules and the planner | `src/game/restocking.js` |
| Schedules, current stock, history | PostgreSQL tables (below) |
| The background tick that restocks due shops | `src/scheduler.js` |
| The shop pages | `src/routes/shops.js`, `src/views/shops/` |
| Optional in-page stock refresh | `src/public/js/shop.js` |
| Administrator operations | `src/game/shop-admin.js`, run through `scripts/shop-admin.js` |

## Defining a shop

A shop is one object in the list in `src/game/shops.js`:

```js
{
  id: 'questionable-grocer',            // permanent slug; appears in URLs and history
  name: 'The Questionable Grocer',
  description: 'Groceries of uncertain provenance ...',
  headerImage: null,                    // '/images/shops/questionable-grocer.png' when you have it
  keeper: { name: 'Mungle', image: null, lines: ['Everything is fresh. Define fresh.'] },
  restock: { minMinutes: 8, maxMinutes: 18, listingsMin: 1, listingsMax: 1 },
  essentials: [
    { itemId: 'soggy-biscuit', price: 5, maxPerPurchase: 20 },
  ],
  restockPool: [
    { itemId: 'fizzing-pebble', weight: 10, price: [18, 24], maxPerPurchase: 3, maxPerRestock: 5 },
    { itemId: 'unlabelled-jar', weight: 1, price: [300, 450], maxPerPurchase: 1, maxPerRestock: 1,
      dailySupplyCap: 4, eligibility: { minAccountAgeHours: 24, requiresPet: true } },
  ],
}
```

The server validates the whole catalog at startup and refuses to start on a
mistake (unknown item, unobtainable item, an item listed twice, a price or
range out of bounds), so errors surface immediately rather than in front
of a player.

### Essentials

Always available, unlimited, fixed price, no eligibility rules. Ordinary
food belongs here so a brand-new player can always feed a pet. The only
limit is `maxPerPurchase`.

### The restock pool

Each restock draws a few entries from this list:

* `weight`: relative chance of being picked. Any positive whole number;
  an entry with weight 10 is twice as likely as one with weight 5. Weights
  are relative to the other entries in the same pool, and they only decide
  anything when a restock draws fewer listings than the pool holds: the
  listings are drawn one at a time, each with probability proportional to
  weight among the entries not yet chosen. So `restock.listingsMax` may be
  at most half the pool size, and the server refuses to start otherwise:
  with three entries and two listings, every restock would hold two of the
  three and a "rare" entry would appear most of the time. The further
  `listingsMax` is below the pool size, the rarer a low-weight entry is.
  With the grocer's three entries and one listing per restock, the pebble
  (weight 10 of 14) appears in about 71% of restocks, the moonbeam (3) in
  21% and the jar (1) in 7%. Grow the pool before raising `listingsMax`.
* `price: [low, high]`: each restock draws a price in this range.
* `quantity: [low, high]` (optional): copies per restock. If absent, the
  item's rarity picks a default from `RARITY_QUANTITY_RANGES`
  (common 4 to 12, uncommon 2 to 5, rare 1 to 2).
* `maxPerPurchase`: most copies in one purchase.
* `maxPerRestock`: most copies one account may buy from one listing.
* `dailySupplyCap` (optional): most copies all restocks together may
  create per UTC day. See "Daily supply caps".
* `eligibility` (optional): who may buy. Currently `minAccountAgeHours`
  and `requiresPet`.

Rarity is descriptive. Nothing in the shop system reads it except the
default quantity range, and an entry can override that. Price and
probability are always explicit per entry.

## How a restock works

1. The scheduler ticks (every 30 seconds by default, `RESTOCK_CHECK_INTERVAL_MS`).
2. For each shop it opens a transaction and locks that shop's `shop_state`
   row with `FOR UPDATE SKIP LOCKED`. If another process already holds the
   lock, this one gets nothing back and moves on. This is what makes several
   server processes safe: only one can be restocking a shop at a time.
3. If the shop is paused or `next_restock_at` is still in the future, the
   transaction ends with nothing done.
4. Otherwise the old listings are deactivated (taking a lock on each, so a
   purchase mid-flight on one finishes or fails first) and the old restock
   event is marked superseded.
5. A new restock event is written. The planner picks how many listings
   (between `listingsMin` and `listingsMax`, at most half the pool),
   which entries (weighted, no repeats), and each one's quantity and
   price, using `crypto.randomInt`.
6. Entries with a daily cap reserve their quantity against
   `daily_item_supply`; if the cap is spent the listing is shrunk or dropped.
7. The listings are inserted, and `shop_state` gets the new event id, the
   time of this restock, and the next time: now plus a random number of
   minutes between `minMinutes` and `maxMinutes`.
8. Commit. If anything fails, nothing changed and the shop is still due,
   so the next tick tries again.

Players never see the next restock time. The page says only whether the
shelves are bare or the shop is closed.

### Missed restocks

If the server was down past a scheduled time, the shop is simply overdue
and gets exactly one restock on the first tick after startup, with the next
one scheduled from then. Missed restocks are never made up, so a long
outage cannot flood the economy.

### Replacement

The next restock replaces the previous assortment entirely, sold or not.
Essentials are unaffected. Old listings, old events and every purchase
record stay in the database for history; they are only marked inactive or
superseded.

### Daily supply caps

A cap counts copies *created by restocks* on one UTC day across every shop,
not copies players own. The count lives in `daily_item_supply`, one row per
item per day, and is updated under a row lock inside the restock
transaction, so two shops restocking at the same moment cannot both squeeze
under the cap. The day boundary is midnight UTC.

## Buying

Players click Buy on a shop page and either get the item or a plain
message saying why not. There is one purchase function for everything,
`purchaseItem` in `src/game/purchases.js`, used for essentials and for
limited listings alike.

### What the form sends

* `item` (an essential's id) **or** `listing` (a `shop_stock` id)
* `quantity`
* `shown_price`: the unit price printed on the page. It is not trusted as
  a price; it is compared with the real one, and if they differ the
  purchase is refused with "the price has changed" so the player can look
  again. Nobody is ever charged more than they were shown.
* `request_id`: a random id the page printed into that form. See
  "Repeated submissions".

The real price comes from the catalog (essentials) or the listing row.

### The transaction, step by step

1. Lock the player's row (`SELECT ... FOR UPDATE`). This account's
   purchases now run one at a time.
2. For a listing: lock the listing row. It must belong to this shop, be
   active (not replaced by a later restock), have enough copies, and the
   quantity must respect `maxPerPurchase` and, counting what this account
   already bought from it, `maxPerRestock`.
3. If this `request_id` was already used by this account, return that
   purchase (if it was for the same thing) or refuse (if not).
4. Compare the shown price with the real one.
5. Insert the purchase record, decrement the listing (the UPDATE itself
   refuses to go below zero), charge the coins (the UPDATE itself refuses
   to go below zero), and grant the item (the upsert refuses to pass 999).
6. Commit. Any failure anywhere rolls back every step.

Locks are always taken in the same order, player then listing, so two
purchases cannot deadlock each other. A restock that retires listings
takes the same listing locks, so a purchase in flight finishes first and
a purchase that arrives during the restock sees the listing as gone.
Should PostgreSQL ever report a deadlock anyway, the purchase is retried
up to twice; the request id makes a retry safe.

### Two players, one copy

Both transactions try to lock the listing. The first gets it and buys. The
second waits, then re-reads the row and finds zero remaining, so it fails
with "sold out". There is no draw, no reservation, no queue: whoever
commits first wins.

### Repeated submissions

Every buy form carries a fresh random `request_id`. The purchase row
stores it, with a hash of shop, item or listing, quantity and shown price,
under a unique constraint per account. A double-click, a browser retry, or
a resent form therefore returns the first purchase instead of making a
second; the same id sent with different details is refused. Because the
record is in the database, this holds across restarts and across server
processes.

The request id is checked first, before the listing is looked at. That
matters: a retry of a purchase that completed must be answered with that
purchase even if the shelf has changed since, because the item sold out,
a restock replaced the listing, or its price changed. The player is never
charged again and never granted a second item; concurrent copies of one
request queue behind the account's row lock and each receives the first
one's result.

### Reading a failed purchase

Every refusal is a `GameRuleError` whose message is shown to the player
and is specific: no such shop, not sold here, listing gone, sold out, only
N left, at most N at a time, at most N from this restock, price changed,
not enough coins, cannot carry more than 999, form out of date. A purchase
that succeeded is in `shop_purchases` with its listing and restock ids, and
its coin movement is in `coin_transactions` with `purchase_id` set.

## Protections

Competition is the point of the shops, so the protections aim to blunt
the advantage of automation and multiple accounts without getting in the
way of a person refreshing a shop by hand. Nothing here claims to stop a
determined script entirely; the layers make it slower, less profitable,
and visible. Every number lives in `src/game/shop-limits.js`.

### Per-account limits (enforced inside the purchase transaction)

With the player's row locked, so simultaneous requests cannot slip past:

| Limit | Default | Where it comes from |
|---|---|---|
| Copies per purchase | per entry (`maxPerPurchase`) | catalog |
| Copies per account per listing | per entry (`maxPerRestock`) | catalog, counted from `shop_purchases` |
| Limited-stock purchases per account per hour | 30 | `listingPurchasesPerHour`, counted from `shop_purchases` |

Essentials are not counted against the hourly limit: they never sell out,
so there is nothing to monopolise, and a player must always be able to
feed their pets.

### Eligibility (limited stock only)

* Any account with a **shopping restriction** in force cannot buy limited
  stock. Essentials remain available. Restrictions are imposed and lifted
  by an administrator with a reason, can carry an expiry, and are listed
  in `shopping_restrictions` so every one can be reviewed. They are never
  imposed automatically.
* A pool entry may declare `eligibility`:
  `minAccountAgeHours` (the account must be at least that old) and
  `requiresPet` (the account must have adopted a pet). Both are facts the
  game already records. Email verification and gameplay progression are
  not implemented yet, so they are not available as rules; adding them is
  future work that needs those features first.

Ordinary essentials never carry eligibility rules, and ordinary limited
stock should not either; reserve them for merchandise valuable enough to
attract throwaway accounts.

### Rate limits (counted in PostgreSQL, shared by every process)

| What | Default | Scope |
|---|---|---|
| Shop page views | 60 per minute | per account |
| Shop page views | 120 per minute | per IP address |
| Buy submissions | 20 per minute | per account |
| Refused purchases | 10 per 5 minutes, then buying pauses for the rest of the window | per account |

The per-address allowance is deliberately larger than the per-account one
so that a household, a school or a mobile network sharing one address is
not blocked before any single account in it would be. Addresses are a
signal, never an identity: nothing is decided about a player from their
address alone. Refused requests get HTTP 429 with a `Retry-After` header
and a plain message.

### The activity log

`shop_activity_log` records what an administrator would want to look at:
every refused purchase with its kind (`sold_out`, `expired_listing`,
`limit_exceeded`, `ineligible`, `restricted`, `price_changed`,
`bad_request`), every rate-limit hit with the limit that fired, and every
purchase of a rare item. Each row has the account, the client address, the
shop and listing, and a few details; nothing else about the visitor is
collected. Rows are deleted after 30 days (`ACTIVITY_LOG_RETENTION_DAYS`)
by the scheduler. Successful purchases are not logged here because
`shop_purchases` already is the record.

### Multiple accounts

Daily rewards, rare purchases and trading will tempt people to run several
accounts. For now the limits above are per account and durable, rare
acquisitions are logged, and restrictions are reviewable. What is
deliberately not done: identifying players by address, device
fingerprinting, or automatic bans for buying fast. When trading arrives,
the activity log and purchase records are the evidence to review before
restricting an account, and item transfers between very new accounts and
established ones are the pattern to watch.

## The tables

| Table | Holds |
|---|---|
| `shop_state` | one row per shop: paused flag, last and next restock time, current restock id. Created at startup if missing, never reset. |
| `shop_restock_events` | one row per restock: who triggered it (`scheduler` or `admin:<name>`), how many listings, when it was superseded. Permanent. |
| `shop_stock` | one row per listing: item, price, initial and remaining quantity, per-purchase and per-account limits, `active`. Permanent. |
| `daily_item_supply` | copies created per item per UTC day. |
| `shop_purchases` | one row per purchase, pointing at its listing for limited stock. |
| `shopping_restrictions` | administrator-imposed limited-stock bans, with reason, expiry and lifting. |
| `shop_activity_log` | refused purchases, rate-limit hits and rare acquisitions, 30-day retention. |
| `request_counters` | fixed-window request counts for every rate limit. |

## Changing things by hand

All of these are edits to `src/game/shops.js` followed by a restart. The
next restock uses the new configuration; the current shelves are unchanged
until then.

* **Add a shop**: append an object as above. The schedule row is created
  on the next startup and the first restock happens on the first tick.
* **Add merchandise**: add an entry to `essentials` or `restockPool`.
* **Change a price**: edit `price` (a number for essentials, a range for
  the pool).
* **Change restock frequency**: edit `restock.minMinutes` and `maxMinutes`.
* **Change how often an item appears**: edit its `weight`, or widen the
  gap between `listingsMax` and the pool size (fewer listings per restock
  make low-weight entries rarer). An item cannot be made to appear in
  every restock through the pool; if it should always be available, make
  it an essential.
* **Change quantities**: set `quantity: [low, high]` on the entry, or edit
  `RARITY_QUANTITY_RANGES` to change the defaults for every entry without
  its own range.
* **Create rare merchandise**: a low `weight`, a small `quantity`, a high
  `price` range, `maxPerPurchase: 1`, and optionally a `dailySupplyCap` and
  `eligibility`.
* **Configure purchase limits**: `maxPerPurchase` and `maxPerRestock` on
  the entry; the hourly and rate limits in `src/game/shop-limits.js`.
* **Configure account eligibility**: `eligibility: { minAccountAgeHours,
  requiresPet }` on a pool entry.
* **Stop selling something**: remove its entry. Players keep what they own.

## The shop page

Each shop page shows the header and keeper artwork (placeholders until the
files exist), a line of the keeper's dialogue, the player's coins, the
essentials with buy forms, then "On the shelves today": the current
listings with price, remaining count, and a buy form, or "Sold out". A
line above the shelves says how long ago the last restock was, never when
the next one is.

Everything works with plain forms. `public/js/shop.js` is an optional
extra: once a minute, while the tab is visible, it fetches
`/shops/<id>/stock.json` (remaining quantities and the current restock id,
nothing more, under the same rate limits as the page) and updates the
numbers in place, turns listings that sold out into "Sold out", and shows
a reload notice if a restock has replaced the shelves. If the script does
not run, nothing is lost but the live numbers.

## Operations

All operations use `npm run shop-admin -- <command>`, run on the server
with the game's `.env`. Access to that machine and those credentials is
the authorisation; there is no web interface for administration. Every
action that changes something requires `--by <name>` and is recorded with
that name, so the history always says who did what.

| Task | Command |
|---|---|
| List shops with paused state and schedule | `npm run shop-admin -- shops` |
| Inspect current stock | `npm run shop-admin -- stock questionable-grocer` |
| Review restock history | `npm run shop-admin -- history questionable-grocer --limit 20` |
| Review a shop's purchases | `npm run shop-admin -- purchases questionable-grocer --limit 50` |
| Everything about one account | `npm run shop-admin -- account wobble` |
| Accounts with the most logged events | `npm run shop-admin -- suspicious --hours 24` |
| Pause automatic restocks | `npm run shop-admin -- pause questionable-grocer --by yourname` |
| Resume them | `npm run shop-admin -- resume questionable-grocer --by yourname` |
| Restock now | `npm run shop-admin -- restock questionable-grocer --by yourname` |
| Stop an account buying limited stock | `npm run shop-admin -- restrict wobble --reason "..." --hours 48 --by yourname` |
| Lift that | `npm run shop-admin -- unrestrict wobble --by yourname` |

A manual restock goes through exactly the same function as the scheduler:
it takes the shop lock, replaces the shelves, obeys daily caps, and is
recorded in `shop_restock_events` with `triggered_by = admin:<name>`. A
paused shop can still be restocked by hand. Omit `--hours` on a
restriction to make it last until lifted.

### Diagnosing a failed purchase

1. `npm run shop-admin -- account <username>` lists the account's recent
   activity. Each refused purchase is there with its kind (`sold_out`,
   `expired_listing`, `limit_exceeded`, `ineligible`, `restricted`,
   `price_changed`, `bad_request`), the listing id, the address, and the
   exact message the player saw.
2. `stock <shop>` shows whether the listing is still active and what is
   left; `history <shop>` shows whether a restock replaced it (the
   listing's `restock_id` will be an older, superseded event).
3. A purchase that succeeded is in the account's purchase list with its
   listing id; its coin movement is in `coin_transactions` with that
   `purchase_id`. If a player says they were charged without receiving the
   item, that cannot happen inside one transaction: look for the purchase
   row. If it exists, the item was granted in the same transaction; check
   the inventory table and the 999 stack limit.
4. Rate-limit refusals are logged as `rate_limited` with the limit that
   fired in `details.scope`.

## Deterministic testing

The restock planner takes a `random` object with one method,
`int(min, max)`. Production passes `crypto.randomInt`; the tests in
`test/game/restocking.test.js` pass fixed or seeded generators from
`test/helpers/fixed-random.js`, so they check exact outcomes rather than
statistics and never fail by chance.

## Load testing

`npm run load-test` (see the README for how to run it) exercises the
whole thing against a running server. Results from the development
machine (one Node process, PostgreSQL 16 on the same host, 8 October 2026):

| Players | Duration | Shop page p50 / p95 | Buy p50 / p95 | Purchases ok / refused | Rush for one copy | Server errors |
|---|---|---|---|---|---|---|
| 30 | 20 s + rush | 13 ms / 148 ms | 14 ms / 125 ms | 179 / 36 | 30 buyers, 141 ms, 1 winner | 0 |
| 100 | 30 s + rush | 12 ms / 377 ms | 13 ms / 336 ms | 906 / 139 | 100 buyers, 356 ms, 1 winner | 0 |

In both runs every refusal was "sold out" (players were given 5,000
coins, so nobody ran short), restocks replaced the shelves every five
seconds while people were buying, three players reloading eight times a
second were rate limited after their allowance (68 and 63 refused reloads),
and afterwards stock sold equalled purchases recorded for every listing,
every ledger summed to its balance, every inventory matched its purchases,
and no request id was used twice.

### What this does and does not show

* It shows the transaction design holds under real overlapping requests:
  no double sale, no negative stock or coins, no lost or duplicated
  purchase, including while restocks replace listings mid-purchase.
* It shows one small process handles a hundred simultaneous shoppers with
  the slowest responses under half a second. The p95 rise from 30 to 100
  players is the Node process serialising page renders and the database
  serialising purchases of the same listing; neither is a problem at this
  scale.
* It does not show a capacity figure. The test ran on one machine with
  the database local, a Node process doing both the load generation and
  the serving, and no network latency. It says nothing about thousands of
  players or about a database on another host. Measure again in the real
  deployment before promising numbers.
* Logins are the slowest requests (p95 1.2 s at 100 at once) because
  scrypt is deliberately slow. That is per login, not per page, and it is
  the intended cost.

## Known limitations

* **One scheduler tick is global.** Restocks are checked every 30 seconds,
  so a shop can be due for up to 30 seconds before it is filled. Lower
  `RESTOCK_CHECK_INTERVAL_MS` if that matters; each check is one small
  query per shop.
* **Rate limits use fixed windows.** A player can make the allowance
  twice in two adjacent seconds across a window boundary. The limits are
  generous enough that this does not matter for people, and the purchase
  transaction has its own per-account limits that do not depend on
  windows.
* **No human verification.** Nothing distinguishes a fast person from a
  script except the limits and the log. A targeted challenge for accounts
  the log flags is the planned next step, not a general CAPTCHA.
* **Eligibility is thin.** Account age and owning a pet are the only
  rules available until email verification and progression exist.
* **Addresses are a weak signal.** The per-IP limits are generous on
  purpose and nothing is decided from an address alone, which also means
  many accounts behind one address are limited only per account.
* **The admin utility is a shell command.** Anyone with the server's
  database credentials can run it. That is appropriate while one person
  runs the game; a web interface with its own authorisation (the
  `users.is_admin` column is ready for it) should come before a second
  administrator does.
* **Restocks never catch up.** After downtime a shop restocks once, by
  design. If the game is down for a day, the day's supply is simply lost.
