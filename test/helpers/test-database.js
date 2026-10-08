import { openDatabase } from '../../src/db/connection.js';
import { syncItemCatalog } from '../../src/game/items.js';

// An in-memory database prepared the same way server.js prepares the real
// one: migrated and with the item catalog loaded.
export function openTestDatabase() {
  const db = openDatabase(':memory:');
  syncItemCatalog(db);
  return db;
}
