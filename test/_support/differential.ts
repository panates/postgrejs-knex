import Knex, { type Knex as KnexType } from 'knex';
import { PostgrejsClient, type PostgrejsOptions } from '../../src/index.js';
import { connectionSettings } from './live.js';

/**
 * The same Knex calls, run through Knex's own `pg` client and through
 * this one, on the same server.
 *
 * This is what holds `decoding: 'pg'` to its promise, so that is the mode
 * these suites run in unless one of them says otherwise. The default
 * decoding is PostgreJS's own and is not meant to match `pg` - what it
 * answers is pinned in `test/B-live` instead.
 *
 * Knex's own suite is the broader instrument, but it asserts only what
 * its authors thought to write down - it says nothing about what a
 * `numeric` column comes back as, because nothing there reads one. This
 * compares the values themselves, so a difference has to be deliberate to
 * survive.
 *
 * Both clients work in the same schema, one after the other, with the
 * schema rebuilt in between: the same starting state, the same
 * statements, and one set of table definitions rather than two.
 */
export interface Differential {
  /** Runs `fn` against each client and hands back both answers. */
  bothWays<T>(fn: (db: KnexType) => Promise<T>): Promise<{ pg: T; pgjs: T }>;
  /**
   * The same, without rebuilding the schema first - for a case that reads
   * and writes nothing, such as a `select` over literals.
   */
  readOnly<T>(fn: (db: KnexType) => Promise<T>): Promise<{ pg: T; pgjs: T }>;
  /** DDL every run starts from. */
  setSchema(statements: string[]): void;
  close(): Promise<void>;
}

/**
 * A value as a comparison can see it.
 *
 * `JSON.stringify` alone cannot: it throws on a BigInt, renders a Buffer
 * as `{"type":"Buffer"}` and a Date as a string that hides the class, and
 * two different classes with the same fields come out identical. Each of
 * those is a difference between these two clients that a test has to be
 * able to see.
 */
export function comparable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (Buffer.isBuffer(value)) return { buffer: value.toString('hex') };
  if (value instanceof Date) return { date: value.toISOString() };
  if (Array.isArray(value)) return value.map(entry => comparable(entry));
  if (typeof value === 'object') {
    const constructor = value.constructor?.name;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = comparable((value as Record<string, unknown>)[key]);
    // A plain object and a class instance with the same keys are not the
    // same answer, and this is where that difference becomes visible.
    return constructor && constructor !== 'Object'
      ? { class: constructor, ...out }
      : out;
  }
  return value;
}

/** What of a `knex.raw()` result is a compatibility surface at all. */
export function comparableResult(result: any): unknown {
  if (Array.isArray(result)) return result.map(entry => comparable(entry));
  if (result && typeof result === 'object' && 'rows' in result)
    return {
      command: result.command,
      rowCount: result.rowCount,
      rows: comparable(result.rows),
    };
  return comparable(result);
}

export async function openDifferential(
  schemaName: string,
  options: PostgrejsOptions = { decoding: 'pg' },
): Promise<Differential> {
  const connection = connectionSettings();
  const pool = { min: 0, max: 4 };
  const dbs = {
    pg: Knex({ client: 'pg', connection, pool }),
    pgjs: Knex({
      client: PostgrejsClient as any,
      connection,
      pool,
      postgrejs: options,
    } as any),
  };
  let ddl: string[] = [];

  async function reset(db: KnexType): Promise<void> {
    await db.raw('drop schema if exists ?? cascade', [schemaName]);
    await db.raw('create schema ??', [schemaName]);
    for (const statement of ddl) await db.raw(statement);
  }

  return {
    setSchema(statements) {
      ddl = statements;
    },
    async readOnly(fn) {
      return { pg: await fn(dbs.pg), pgjs: await fn(dbs.pgjs) };
    },
    async bothWays(fn) {
      await reset(dbs.pg);
      const fromPg = await fn(dbs.pg);
      await reset(dbs.pgjs);
      const fromPgjs = await fn(dbs.pgjs);
      return { pg: fromPg, pgjs: fromPgjs };
    },
    async close() {
      await dbs.pg.raw('drop schema if exists ?? cascade', [schemaName]);
      await dbs.pg.destroy();
      await dbs.pgjs.destroy();
    },
  };
}
