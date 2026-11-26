import type { Knex } from 'knex';
import type { DataTypeMap, FetchAsStringItem } from 'postgrejs';
import { FETCH_AS_STRING_OIDS } from './constants.js';

/**
 * What this client understands over and above Knex's own configuration.
 *
 * ```ts
 * const db = knex({
 *   client: PostgrejsClient,
 *   connection: 'postgres://localhost:5432/mydb',
 *   postgrejs: { prepare: false },
 * });
 * ```
 */
export interface PostgrejsOptions {
  /**
   * What values come back as.
   *
   * - `'native'`, the default - PostgreJS's own decoding. A `bigint`
   *   arrives as a `BigInt` once it passes 2^53, a `numeric` as a
   *   `Numeric` once a double cannot hold it, a range as a `Range`, a
   *   `point` as a `Point`. Nothing is flattened to a string on the way
   *   out.
   * - `'pg'` - the narrower set of JavaScript types the older driver
   *   produces, for code being moved onto this one that reads `bigint`
   *   and `numeric` as strings and would otherwise need changing in
   *   every model.
   *
   * `'pg'` is a way to land the switch in one commit and deal with the
   * types in the next, rather than a mode to settle on: it asks the
   * server to render those columns as text, which is both a round of
   * parsing and a loss of precision that the default does not pay.
   *
   * @see {@link ../docs/MIGRATION-pg-to-postgrejs.md} for the whole
   * table of what moves.
   */
  decoding?: 'pg' | 'native';

  /**
   * Further OIDs to ask the server to render as text, on top of whatever
   * {@link decoding} already asks for.
   *
   * An entry may be an OID or PostgreJS's `{ oid, arrays }` selector -
   * naming an OID on its own also reaches columns of arrays of it.
   */
  fetchAsString?: FetchAsStringItem[];

  /**
   * Whether each parameter's type is left to the server to resolve from
   * where its placeholder appears, which is what `pg` does.
   *
   * Defaults to `true`, and there is very little reason to turn it off:
   * a declared type is one PostgreSQL will not coerce, which breaks
   * ordinary Knex queries such as `where('txt', 42)` and
   * `where('jb', { a: 1 })`. `false` hands every value to PostgreJS to
   * type from the value itself, keeping its binary encoders in play.
   *
   * @see {@link ./params.ts} for what each setting sends.
   */
  inferParameterTypes?: boolean;

  /**
   * Whether a `DatabaseError` is made to read like `pg`'s: the caret
   * diagram stripped from `message`, and `position` as a string.
   *
   * On by default. Every structured field (`code`, `constraint`,
   * `detail`, `table`, ...) is identical either way.
   */
  normalizeErrors?: boolean;

  /**
   * Whether statements are cached as server-side prepared statements.
   *
   * Leave unset to follow the connection's own `prepare` setting. `false`
   * is what PgBouncer in transaction pooling mode needs before 1.21,
   * where a named statement does not survive to the next call.
   */
  prepare?: boolean;

  /**
   * Whether a failed statement inside a transaction leaves the rest of
   * the transaction usable.
   *
   * Defaults to `false`, which is PostgreSQL's own behaviour and what
   * Knex - and `pg` under it - has always given: the transaction is
   * aborted and nothing but a rollback is accepted after it. PostgreJS
   * defaults this to `true` instead, wrapping every statement in a
   * savepoint of its own.
   */
  rollbackOnError?: boolean;

  /**
   * A custom `DataTypeMap`, to override how individual PostgreSQL types
   * are decoded. Defaults to PostgreJS's `GlobalTypeMap`.
   */
  typeMap?: DataTypeMap;
}

/** Knex's configuration, plus this client's own options. */
export interface PostgrejsKnexConfig extends Knex.Config {
  postgrejs?: PostgrejsOptions;
}

/** {@link PostgrejsOptions} with every default filled in. */
export interface ResolvedPostgrejsOptions {
  fetchAsString?: FetchAsStringItem[];
  inferParameterTypes: boolean;
  normalizeErrors: boolean;
  prepare?: boolean;
  rollbackOnError: boolean;
  typeMap?: DataTypeMap;
}

/**
 * The options one client runs on, defaults applied.
 *
 * @param options What the user configured, if anything.
 * @returns Every option this client reads, with no holes left in it.
 */
export function resolveOptions(
  options: PostgrejsOptions | undefined,
): ResolvedPostgrejsOptions {
  const given = options ?? {};
  const pgDecoding = given.decoding === 'pg';
  const extra = given.fetchAsString;
  let fetchAsString: FetchAsStringItem[] | undefined;
  if (pgDecoding)
    fetchAsString = extra
      ? [...FETCH_AS_STRING_OIDS, ...extra]
      : FETCH_AS_STRING_OIDS;
  else fetchAsString = extra;
  return {
    fetchAsString,
    inferParameterTypes: given.inferParameterTypes !== false,
    normalizeErrors: given.normalizeErrors !== false,
    prepare: given.prepare,
    rollbackOnError: given.rollbackOnError === true,
    typeMap: given.typeMap,
  };
}
