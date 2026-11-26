import Knex, { type Knex as KnexType } from 'knex';
import { Pool } from 'postgrejs';
import { PostgrejsClient, type PostgrejsOptions } from '../../src/index.js';

/** Where `test/_support/env.ts` points, as a connection object. */
export function connectionSettings(): Record<string, any> {
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  };
}

/** A Knex instance on this client, with no schema of its own. */
export function openKnex(
  options?: PostgrejsOptions,
  config?: Partial<KnexType.Config>,
): KnexType {
  return Knex({
    client: PostgrejsClient as any,
    connection: connectionSettings(),
    pool: { min: 0, max: 4 },
    ...(options ? { postgrejs: options } : {}),
    ...config,
  } as any);
}

/** A PostgreJS pool on the same server, for the `connectionPool` tests. */
export function openPool(): Pool {
  return new Pool({ ...connectionSettings(), max: 4 });
}

/**
 * A Knex instance with a schema of its own, dropped again on close.
 *
 * The schema matters: a pool hands out a different connection per call,
 * so nothing here may depend on a `search_path` set on one of them.
 */
export interface LiveDb {
  db: KnexType;
  schema: string;
  close(): Promise<void>;
}

export async function openLiveDb(
  schemaName: string,
  options?: PostgrejsOptions,
  config?: Partial<KnexType.Config>,
): Promise<LiveDb> {
  const db = openKnex(options, config);
  await db.raw('drop schema if exists ?? cascade', [schemaName]);
  await db.raw('create schema ??', [schemaName]);
  return {
    db,
    schema: schemaName,
    async close() {
      await db.raw('drop schema if exists ?? cascade', [schemaName]);
      await db.destroy();
    },
  };
}
