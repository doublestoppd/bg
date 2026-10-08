import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

// Opens (or creates) the SQLite database file and brings its schema up to
// date. Pass ':memory:' to get a throwaway database, which the tests use.
export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);

  // Enforce REFERENCES constraints; SQLite leaves them off by default.
  db.pragma('foreign_keys = ON');
  // Write-ahead logging lets readers proceed while a write is in progress.
  if (databasePath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  runMigrations(db);
  return db;
}
