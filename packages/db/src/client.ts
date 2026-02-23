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
    waitForConnections: true,
    connectionLimit: poolConfig?.connectionLimit ?? 10,
    queueLimit: poolConfig?.queueLimit ?? 0,
    idleTimeout: poolConfig?.idleTimeout ?? 60_000,
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool };
}
