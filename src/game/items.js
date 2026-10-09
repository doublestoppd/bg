import { withTransaction } from '../db/pool.js';
import { STAT_NAMES } from './stats.js';
import { upsertItem, retireItemsNotIn } from '../db/items.js';

// The item catalog. This file is the authoritative list of every item in
// the game; the items table in PostgreSQL is a synchronised copy.
//
// To add an item, append an object to the list below and restart the
// server (syncItemCatalog runs at startup). Rules:
//   * id is a lowercase slug that never changes and is never reused, even
//     after the item is removed. Player inventories refer to it.
//   * category is one of CATEGORIES.
//   * image is a URL path such as '/images/items/soggy-biscuit.png', or
//     null to show a placeholder until the artwork exists.
//   * effects lists what happens to a pet when the item is used on it.
//     Only food is usable at the moment; each key is a pet stat and the
//     value is added to it (stats are capped, see game/pets.js).
//   * obtainable (optional, default true) says whether the item may still
//     be handed out. Set it to false to end a limited-time item: nothing
//     can grant it any more, but players who own one can still use it.
//
// An item therefore has three possible states:
//   obtainable      in the catalog, obtainable: true   can be granted and used
//   limited-time    in the catalog, obtainable: false  can be used, not granted
//   retired         deleted from this list              can only be kept
//
// To retire an item, delete it from this list. The database row is marked
// retired, players keep what they own, and the id must not be given to a
// new item.

export const CATEGORIES = ['food', 'curiosity'];

const items = [
  {
    id: 'soggy-biscuit',
    name: 'Soggy Biscuit',
    description: 'It was a biscuit once. Pets are not fussy.',
    category: 'food',
    image: null,
    effects: { hunger: 15 },
  },
  {
    id: 'humming-turnip',
    name: 'Humming Turnip',
    description: 'A turnip that hums quietly in B-flat. Filling, if unsettling.',
    category: 'food',
    image: null,
    effects: { hunger: 25, happiness: 5 },
  },
  {
    id: 'fizzing-pebble',
    name: 'Fizzing Pebble',
    description: 'Looks like a pebble, fizzes like a sweet. Snibbles hoard them.',
    category: 'food',
    image: null,
    effects: { hunger: 5, happiness: 20 },
  },
  {
    id: 'pickled-moonbeam',
    name: 'Pickled Moonbeam',
    description: 'A jar of moonlight, pickled. Tastes faintly of Tuesday.',
    category: 'food',
    image: null,
    effects: { hunger: 40, happiness: 15, health: 10 },
  },
  {
    id: 'jubilee-crumpet',
    name: 'Jubilee Crumpet',
    description: 'Baked for the opening of Blobgarden and handed out at the gate. No more are being made.',
    category: 'food',
    image: null,
    effects: { hunger: 30, happiness: 30 },
    obtainable: false,
  },
  {
    id: 'unlabelled-jar',
    name: 'Unlabelled Jar',
    description: 'A jar. Something inside is tapping. Best not opened yet.',
    category: 'curiosity',
    image: null,
    effects: {},
  },
];

validateCatalog(items);
for (const item of items) {
  if (item.obtainable === undefined) item.obtainable = true;
}

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
export async function syncItemCatalog(pool, catalog = items) {
  await withTransaction(pool, async (db) => {
    for (const item of catalog) {
      await upsertItem(db, item);
    }
    await retireItemsNotIn(db, catalog.map((item) => item.id));
  });
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
    if (item.obtainable !== undefined && typeof item.obtainable !== 'boolean') {
      throw new Error(`Item "${item.id}" obtainable must be true or false`);
    }
    for (const [stat, amount] of Object.entries(item.effects || {})) {
      if (!STAT_NAMES.includes(stat)) throw new Error(`Item "${item.id}" affects unknown stat "${stat}"`);
      if (!Number.isInteger(amount)) throw new Error(`Item "${item.id}" effect "${stat}" must be a whole number`);
    }
  }
}
