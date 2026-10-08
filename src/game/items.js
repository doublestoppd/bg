import { upsertItem, retireItemsNotIn } from '../db/items.js';

// The item catalog. This file is the authoritative list of every item in
// the game; the items table in SQLite is a synchronised copy.
//
// To add an item, append an object to the list below and restart the
// server (syncItemCatalog runs at startup). Rules:
//   * id is a lowercase slug that never changes and is never reused, even
//     after the item is removed. Player inventories refer to it.
//   * category is one of CATEGORIES; rarity is one of RARITIES.
//   * image is a URL path such as '/images/items/soggy-biscuit.png', or
//     null to show a placeholder until the artwork exists.
//   * effects lists what happens to a pet when the item is used on it.
//     Only food is usable at the moment; each key is a pet stat and the
//     value is added to it (stats are capped, see game/pets.js).
//
// To remove an item from the game, delete it from this list. The database
// row is marked retired, players keep what they own, and the id must not
// be given to a new item.

export const CATEGORIES = ['food', 'curiosity'];
export const RARITIES = ['common', 'uncommon', 'rare'];
const EFFECT_STATS = ['hunger', 'happiness', 'health'];

const items = [
  {
    id: 'soggy-biscuit',
    name: 'Soggy Biscuit',
    description: 'It was a biscuit once. Pets are not fussy.',
    category: 'food',
    rarity: 'common',
    image: null,
    effects: { hunger: 15 },
  },
  {
    id: 'humming-turnip',
    name: 'Humming Turnip',
    description: 'A turnip that hums quietly in B-flat. Filling, if unsettling.',
    category: 'food',
    rarity: 'common',
    image: null,
    effects: { hunger: 25, happiness: 5 },
  },
  {
    id: 'fizzing-pebble',
    name: 'Fizzing Pebble',
    description: 'Looks like a pebble, fizzes like a sweet. Snibbles hoard them.',
    category: 'food',
    rarity: 'uncommon',
    image: null,
    effects: { hunger: 5, happiness: 20 },
  },
  {
    id: 'pickled-moonbeam',
    name: 'Pickled Moonbeam',
    description: 'A jar of moonlight, pickled. Tastes faintly of Tuesday.',
    category: 'food',
    rarity: 'rare',
    image: null,
    effects: { hunger: 40, happiness: 15, health: 10 },
  },
  {
    id: 'unlabelled-jar',
    name: 'Unlabelled Jar',
    description: 'A jar. Something inside is tapping. Best not opened yet.',
    category: 'curiosity',
    rarity: 'uncommon',
    image: null,
    effects: {},
  },
];

validateCatalog(items);

export function allItems() {
  return items;
}

export function findItem(id) {
  return items.find((item) => item.id === id) || null;
}

// Brings the items table in line with the catalog. Safe to run on every
// startup: existing rows are updated in place, new ones inserted, and rows
// for items no longer in the catalog are marked retired rather than
// deleted, so player inventories are never touched.
export function syncItemCatalog(db, catalog = items) {
  db.transaction(() => {
    for (const item of catalog) {
      upsertItem(db, { ...item, effects: JSON.stringify(item.effects) });
    }
    retireItemsNotIn(db, catalog.map((item) => item.id));
  })();
}

// Catches catalog mistakes at startup instead of at the moment a player
// tries to use the item.
function validateCatalog(list) {
  const seen = new Set();
  for (const item of list) {
    if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error(`Item id "${item.id}" must be a lowercase slug`);
    if (seen.has(item.id)) throw new Error(`Duplicate item id "${item.id}"`);
    seen.add(item.id);
    if (!item.name || !item.description) throw new Error(`Item "${item.id}" needs a name and description`);
    if (!CATEGORIES.includes(item.category)) throw new Error(`Item "${item.id}" has unknown category "${item.category}"`);
    if (!RARITIES.includes(item.rarity)) throw new Error(`Item "${item.id}" has unknown rarity "${item.rarity}"`);
    for (const [stat, amount] of Object.entries(item.effects || {})) {
      if (!EFFECT_STATS.includes(stat)) throw new Error(`Item "${item.id}" affects unknown stat "${stat}"`);
      if (!Number.isInteger(amount)) throw new Error(`Item "${item.id}" effect "${stat}" must be a whole number`);
    }
  }
}
