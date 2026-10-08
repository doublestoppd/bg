import pg from 'pg';

// PostgreSQL returns 64-bit integers (BIGINT, and COUNT(*) results) as
// strings so that nothing is lost above 2^53. Every number in this game is
// far below that (coins are capped at a billion), so convert them to plain
// JavaScript numbers once, here, instead of in every query.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Integer ${value} is too large to handle safely`);
  return number;
});

// Opens a connection pool. Every database function in src/db takes a `db`
// argument that is either this pool (for a single query) or a client
// checked out by withTransaction (for several queries that must succeed or
// fail together). Both have the same .query(text, params) method.
export function createPool(connectionString) {
  if (!connectionString) throw new Error('createPool needs a connection string');
  return new pg.Pool({ connectionString, max: 10 });
}

// Runs work(client) inside one transaction on one dedicated connection.
// The transaction is committed if work returns and rolled back if it
// throws; the connection always goes back to the pool.
export async function withTransaction(pool, work) {
  const client = await pool.connect();
  client.inTransaction = true; // lets assertInTransaction check below
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); // the original error matters more
    throw error;
  } finally {
    client.inTransaction = false;
    client.release();
  }
}

// Some game helpers run several statements that must succeed or fail
// together (take coins, then write the ledger). They call this so that a
// mistake, such as passing the pool instead of a transaction client, fails
// loudly in development rather than quietly losing atomicity.
export function assertInTransaction(db, what) {
  if (!db.inTransaction) throw new Error(`${what} must run inside withTransaction`);
}

// PostgreSQL error codes this application reacts to.
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_DEADLOCK = '40P01';
export const PG_SERIALIZATION_FAILURE = '40001';
