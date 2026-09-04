import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from './schema.js';

export interface DbPoolConfig {
  /** Max simultaneous connections (default: 10) */
  connectionLimit?: number;
  /** Max queued requests when pool is full; 0 = unlimited (default: 0) */
  queueLimit?: number;
  /** Close idle connections after this many ms (default: 60 000) */
  idleTimeout?: number;
}

export function createDb(databaseUrl: string, poolConfig?: DbPoolConfig) {
  const pool = mysql.createPool({
    uri: databaseUrl,
    // Every TIMESTAMP is read and written as UTC regardless of the server's session
    // time zone (analytics compares against UTC cutoffs computed in JavaScript).
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: poolConfig?.connectionLimit ?? 10,
    queueLimit: poolConfig?.queueLimit ?? 0,
    idleTimeout: poolConfig?.idleTimeout ?? 60_000,
  });
  // `timezone: 'Z'` only fixes how the driver serialises JS Dates; the server session must
  // agree so TIMESTAMP columns, DATE_FORMAT() and HOUR() all speak UTC as well.
  // The event hands over the underlying callback-style connection; commands queue in order,
  // so the SET runs before any query issued by the consumer of this connection.
  pool.on('connection', (connection) => {
    try {
      (connection as unknown as { query(sql: string, cb: (err: unknown) => void): unknown })
        .query("SET time_zone = '+00:00'", () => { /* best effort — the driver-side conversion still applies */ });
    } catch {
      /* ignore */
    }
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool };
}
