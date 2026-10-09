# Economy

How coins, prices, scarcity and limits fit together in Blobgarden, and
the rules that keep the economy honest. For the mechanics of shops and
restocks see `docs/SHOPS.md`; for the code layout see
`docs/ARCHITECTURE.md`.

## The shape of it

Blobgarden has a hybrid economy: easy, cheap pet care on one side, and
scarce collectibles on the other. A player should never struggle to keep
a pet fed and happy, and should always have something expensive and
unusual to save up for. Both come through the same mechanism: shop
restocks put merchandise on shared shelves in limited quantities at
variable prices, first come first served. Ordinary food is kept cheap and
plentiful by its settings (a high weight so it is on the shelves most of
the time, a large quantity range, a low price range, no eligibility
rules); collectibles are made scarce by theirs. Price, probability,
quantity and supply are separate dials (below), and new accounts start
with a few items of food so nobody is stuck before their first restock.

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
* Each listing gets a price drawn from the entry's `[low, high]` range at
  each restock. Prices are whole coins from 1 to 1,000,000 (`MAX_PRICE`).
* The price a player is shown is the price they pay. If it differs from
  the real one when they click Buy, the purchase is refused and they look
  again. Nothing from the browser is ever used as a price.

### Starting price points

With a 100-coin purse and biscuits at 4 to 6 coins, a new player can
feed a pet about twenty times before earning anything. Turnips at 10 to
14 are the "nice" food.
Limited treats sit around 20, the moonbeam around 55 to 80, and the first
curiosity at 300 to 450: a goal that takes saving. These are opening
values to tune once rewards exist; see "Tuning" below.

## Scarcity: four separate dials, none of them on the item

Items have no rarity field, score or tier. An item is defined only by its
identity, properties and behaviour (`src/game/items.js`). How scarce it
is emerges from how it enters the game, and every one of those settings
belongs to the thing that distributes it, today a shop and later an
event, an exploration drop or a daily prize. There are no per-purchase,
per-account or per-day caps on a listing either: whoever reaches a
listing first may buy all of it.

| Dial | Where it is set | What it controls |
|---|---|---|
| **Restock probability** | `weight` on the shop's pool entry, together with how many listings a restock draws | How likely the item is to be picked for a restock, relative to the rest of that shop's pool. Weights are ratios, not percentages. Fewer listings per restock make low weights scarcer; a restock never draws more than half the pool, so nothing appears just because the pool is small. |
| **Quantity per restock** | `quantity: [low, high]` on the entry | How many copies a listing starts with. Independent of the weight. |
| **Current availability** | `shop_stock.remaining_quantity` | What is on the shelf right now, shared by everyone. |
| **Overall supply** | which shops carry the item at all, how often they restock, and the sum of past listings | Where copies can enter the world and how many have. |

So the same item can be plentiful in one shop and almost never seen in
another, or appear often but two at a time. Players will work out what is scarce from what
they see on the shelves and what others will trade for it; the game never
tells them.

### How supply is measured

"Supply" of an item overall is the sum of `initial_quantity` over its
listings in `shop_stock` plus any other source that grants it (welcome
gifts today, rewards later). Copies listed but never sold are not in
anyone's hands but did enter the world; copies sold are in inventories.

## Limits

| Limit | Default | Purpose |
|---|---|---|
| Purchases per account per hour | 30 | blunts automated sweeping |
| Stack size per item per player | 999 | keeps hoarding and numbers sane |
| Purchase quantity ceiling | 99 | sanity bound above any entry's own |
| Purse | 1,000,000,000 | integer safety |

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
* prices, weights, quantities: `src/game/shops.js`
* hourly purchase limit and rate limits: `src/game/shop-limits.js`
* stack size and purchase ceiling: `src/game/inventory.js`,
  `src/game/purchases.js`

Watch the ledger and `shop_purchases` after a change: the ratio of coins
entering (rewards) to coins leaving (purchases), and how long low-weight
listings last on the shelf, say whether prices and quantities are right.

## What is deliberately not here yet

Minigame and daily rewards, exploration, item collections, trading and
player-owned shops. Each will reuse `awardCoins`, `grantItem` and
`takeItem`, which is why those are the only ways coins and items move.
Trading in particular will need the activity log and per-account records
described in `docs/SHOPS.md` ("Multiple accounts") before it is safe.
