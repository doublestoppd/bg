# Shops

How Blobgarden's NPC shops are defined, stocked, bought from, protected,
and operated. Written for a JavaScript developer who is not a database
specialist. (Purchasing of limited stock, anti-abuse rules and the admin
utility are added in later milestones; this document grows with them.)

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

## Defining a shop

A shop is one object in the list in `src/game/shops.js`:

```js
{
  id: 'questionable-grocer',            // permanent slug; appears in URLs and history
  name: 'The Questionable Grocer',
  description: 'Groceries of uncertain provenance ...',
  headerImage: null,                    // '/images/shops/questionable-grocer.png' when you have it
  keeper: { name: 'Mungle', image: null, lines: ['Everything is fresh. Define fresh.'] },
  restock: { minMinutes: 8, maxMinutes: 18, listingsMin: 4, listingsMax: 8 },
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
  are relative to the other entries in the same pool.
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
   (between `listingsMin` and `listingsMax`), which entries (weighted, no
   repeats), and each one's quantity and price, using `crypto.randomInt`.
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

## The tables

| Table | Holds |
|---|---|
| `shop_state` | one row per shop: paused flag, last and next restock time, current restock id. Created at startup if missing, never reset. |
| `shop_restock_events` | one row per restock: who triggered it (`scheduler` or `admin:<name>`), how many listings, when it was superseded. Permanent. |
| `shop_stock` | one row per listing: item, price, initial and remaining quantity, per-purchase and per-account limits, `active`. Permanent. |
| `daily_item_supply` | copies created per item per UTC day. |
| `shop_purchases` | one row per purchase, pointing at its listing for limited stock. |

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
* **Change how often an item appears**: edit its `weight`. To make it
  appear in every restock, set `listingsMin` to the pool size and give it
  any weight.
* **Change quantities**: set `quantity: [low, high]` on the entry, or edit
  `RARITY_QUANTITY_RANGES` to change the defaults for every entry without
  its own range.
* **Create rare merchandise**: a low `weight`, a small `quantity`, a high
  `price` range, `maxPerPurchase: 1`, and optionally a `dailySupplyCap` and
  `eligibility`.
* **Stop selling something**: remove its entry. Players keep what they own.

## Deterministic testing

The restock planner takes a `random` object with one method,
`int(min, max)`. Production passes `crypto.randomInt`; the tests in
`test/game/restocking.test.js` pass fixed or seeded generators from
`test/helpers/fixed-random.js`, so they check exact outcomes rather than
statistics and never fail by chance.
