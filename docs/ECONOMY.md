# Economy

How coins, prices, scarcity and limits fit together in Blobgarden, and
the rules that keep the economy honest. For the mechanics of shops and
restocks see `docs/SHOPS.md`; for the code layout see
`docs/ARCHITECTURE.md`.

## The shape of it

Blobgarden has a hybrid economy: easy, cheap pet care on one side, and
scarce collectibles on the other. A player should never struggle to keep
a pet fed and happy, and should always have something expensive and
unusual to save up for. The two sides are kept apart on purpose:

* **Essentials** (ordinary food) are always in stock at fixed, low prices
  with no eligibility rules. Nothing about scarcity ever touches them.
* **Limited merchandise** appears in random restocks in limited quantity
  at variable prices, is shared by every player, and sells out. Rarity,
  price, probability and quantity are separate dials (below).

Rare collectibles are desirable but never required for a healthy pet.

## Coins

* One currency, **coins**, stored as `users.coins`. New accounts start
  with 100 (`STARTING_COINS` in `src/game/accounts.js`) and a few welcome
  items.
* `src/game/currency.js` is the only code that changes a balance. Every
  change is one conditional UPDATE plus a row in `coin_transactions`, the
  ledger, which always sums to the balance. The table forbids a balance
  below 0 or above 1,000,000,000 (`MAX_COINS`).
* Coins currently enter the game only as the welcome purse. Minigames,
  daily activities and exploration rewards will call `awardCoins` with
  their own reason; the ledger then shows exactly where every coin came
  from.
* Coins leave the game through shop purchases. Nothing is ever refunded
  automatically; a purchase either happens completely or not at all.

## Prices

* Items have no price of their own. A shop decides what it charges, so
  two shops may price the same item differently and a future player shop
  can price it however its owner likes.
* Essentials have a fixed price per shop. Limited listings get a price
  drawn from the entry's `[low, high]` range at each restock. Prices are
  whole coins from 1 to 1,000,000 (`MAX_PRICE`).
* The price a player is shown is the price they pay. If it differs from
  the real one when they click Buy, the purchase is refused and they look
  again. Nothing from the browser is ever used as a price.

### Starting price points

With a 100-coin purse and 5-coin biscuits, a new player can feed a pet
twenty times before earning anything. Turnips at 12 are the "nice" food.
Limited treats sit around 20, the rare food around 55 to 80, and the first
curiosity at 300 to 450: a goal that takes saving. These are opening
values to tune once rewards exist; see "Tuning" below.

## Scarcity: five separate dials

These are deliberately not one property:

| Dial | Where it is set | What it controls |
|---|---|---|
| **Rarity** | `rarity` on the item | A label players see. Nothing in shops reads it except the default quantity range. |
| **Restock probability** | `weight` on the pool entry, together with how many listings a restock draws | How likely the item is to be picked for a restock, relative to the rest of that shop's pool. Fewer listings per restock make low weights rarer; a restock never draws the whole pool. |
| **Quantity per restock** | `quantity: [low, high]` on the entry, else the rarity default | How many copies a listing starts with. |
| **Current availability** | `shop_stock.remaining_quantity` | What is on the shelf right now, shared by everyone. |
| **Overall supply** | `dailySupplyCap` on the entry, and the sum of past listings | How many copies can enter the world per UTC day, and how many have. |

So an item can be labelled rare but common in one shop's restocks, or
labelled common but capped at four a day. The distribution is a property
of the activity that distributes it, which today is the shop and later
may be an exploration reward or a daily prize.

### How supply is measured

A daily cap counts copies *created by restocks* on that UTC day across
every shop, in `daily_item_supply`. It does not count copies already in
players' inventories, and it does not count copies that were listed but
never sold. "Supply" of an item overall is the sum of `initial_quantity`
over its listings plus any other source that grants it (welcome gifts
today, rewards later).

## Limits

| Limit | Default | Purpose |
|---|---|---|
| Copies per purchase | per entry | keeps one click from emptying a shelf |
| Copies per account per listing | per entry (`maxPerRestock`) | spreads a restock across players |
| Limited purchases per account per hour | 30 | blunts automated sweeping |
| Stack size per item per player | 999 | keeps hoarding and numbers sane |
| Purchase quantity ceiling | 99 | sanity bound above any entry's own |
| Purse | 1,000,000,000 | integer safety |

Essentials have only the per-purchase limit.

## Integrity rules

* Every purchase is one database transaction: stock, coins, inventory,
  the purchase record and the ledger row commit together or not at all.
* Stock and coins are decremented with conditional updates that refuse to
  go below zero, under row locks taken in a fixed order, so two buyers of
  the last copy produce exactly one sale.
* Every buy form carries a one-time request id stored with the purchase
  under a unique constraint, so a resubmitted form cannot buy twice.
* All quantities, prices and amounts are validated as safe integers within
  the limits above before any SQL runs, and the tables' CHECK constraints
  are the backstop.
* Items are never created by the browser. The server grants them from the
  catalog through one function, `grantItem`, which refuses items that are
  no longer obtainable.

## Tuning

Change numbers in these places and restart:

* starting coins and welcome items: `src/game/accounts.js`
* essential prices, pool prices, weights, quantities, caps:
  `src/game/shops.js`
* default quantity by rarity: `RARITY_QUANTITY_RANGES` in the same file
* hourly purchase limit and rate limits: `src/game/shop-limits.js`
* stack size and purchase ceiling: `src/game/inventory.js`,
  `src/game/purchases.js`

Watch the ledger and `shop_purchases` after a change: the ratio of coins
entering (rewards) to coins leaving (purchases), and how long rare
listings last on the shelf, say whether prices and quantities are right.

## What is deliberately not here yet

Minigame and daily rewards, exploration, item collections, trading and
player-owned shops. Each will reuse `awardCoins`, `grantItem` and
`takeItem`, which is why those are the only ways coins and items move.
Trading in particular will need the activity log and per-account records
described in `docs/SHOPS.md` ("Multiple accounts") before it is safe.
