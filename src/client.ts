import * as postgrejs from 'postgrejs';
import {
  Connection,
  type ConnectionConfiguration,
  ConnectionState,
  type Pool,
  type QueryOptions,
} from 'postgrejs';
import {
  type PostgrejsKnexConfig,
  type ResolvedPostgrejsOptions,
  resolveOptions,
} from './config.js';
import { toConnectionConfiguration } from './connection-settings.js';
import { normalizeError } from './errors.js';
import { ClientPg } from './knex-internals.js';
import { toBindParams } from './params.js';
import { toQueryResult } from './result.js';
import { createRowStream, type StreamOptions } from './stream.js';

/** A connection with the two properties Knex hangs off its own. */
interface PooledConnection extends Connection {
  __knexUid?: string;
  __knex__disposed?: unknown;
}

/** One statement, as Knex's runner hands it over. */
interface QueryObject {
  sql: string;
  bindings?: readonly unknown[];
  options?: Record<string, any> & { rowMode?: 'array' };
  response?: unknown;
  method?: string;
}

/**
 * A Knex client that runs on PostgreJS instead of `pg`.
 *
 * ```ts
 * import knex from 'knex';
 * import { PostgrejsClient } from 'knex-postgrejs';
 *
 * const db = knex({
 *   client: PostgrejsClient,
 *   connection: 'postgres://localhost:5432/mydb',
 * });
 * ```
 *
 * Only the half of Knex's PostgreSQL client that talks to `pg` is
 * replaced. The SQL - the query compiler, the schema and table compilers,
 * the `$n` placeholder rewriting, the transaction class - stays Knex's
 * own, so this client speaks whatever PostgreSQL dialect the installed
 * Knex speaks.
 */
export class PostgrejsClient extends ClientPg {
  /** Knex's own, which parses what `select version()` answered. */
  declare protected _parseVersion: (versionString: string) => string;
  protected _pgjsOptionsCache?: ResolvedPostgrejsOptions;
  protected _connectionConfigCache?: {
    source: unknown;
    config: ConnectionConfiguration;
  };

  /**
   * This client's own options, as {@link resolveOptions} settled them.
   */
  /* Read from `config` on first use rather than computed in a constructor,
     because Knex builds the client of a transaction with
     `Object.create(client.constructor.prototype)` and copies seven named
     fields onto it - no constructor runs, so an instance field set in one
     would be `undefined` for every query inside a transaction. `config` is
     one of the seven. */
  protected get _pgjsOptions(): ResolvedPostgrejsOptions {
    let options = this._pgjsOptionsCache;
    if (!options) {
      options = resolveOptions((this.config as PostgrejsKnexConfig)?.postgrejs);
      this._pgjsOptionsCache = options;
    }
    return options;
  }

  /**
   * The driver module, which Knex keeps on `client.driver`.
   *
   * @returns PostgreJS itself.
   */
  _driver(): typeof postgrejs {
    return postgrejs;
  }

  /**
   * Opens one connection, before Knex's own version check and search path
   * run on it.
   *
   * @returns A connected PostgreJS connection.
   */
  async _acquireOnlyConnection(): Promise<Connection> {
    const connection = new Connection(
      this._connectionConfiguration(),
    ) as PooledConnection;
    hidePassword(connection);
    // What Knex's pool reads to decide a connection is no longer usable.
    connection.on('error', error => {
      connection.__knex__disposed = error;
    });
    connection.on('close', () => {
      connection.__knex__disposed ??= 'Connection ended unexpectedly';
    });
    await connection.connect();
    return connection;
  }

  /**
   * Closes a connection the pool is finished with.
   *
   * @param connection The connection to close.
   */
  async destroyRawConnection(connection: Connection): Promise<void> {
    await connection.close();
  }

  /**
   * Whether a pooled connection is still usable.
   *
   * @param connection The connection the pool is about to hand out.
   * @returns Whether it is still connected.
   */
  async validateConnection(connection: Connection): Promise<boolean> {
    return connection.state === ConnectionState.READY;
  }

  /**
   * The server's version, for the feature checks Knex makes on it.
   *
   * @param connection A connected connection.
   * @returns The version string, such as `18.6`.
   */
  /* The server sends `server_version` as a startup parameter and PostgreJS
     keeps it, so this costs nothing where Knex's `pg` client spends a round
     trip on `select version()` for every pool. */
  async checkVersion(connection: Connection): Promise<string> {
    const version = connection.sessionParameters.server_version;
    if (version) return version;
    /* c8 ignore start - every supported server sends the parameter */
    const result = await connection.query('select version()');
    return this._parseVersion(String((result.rows as any[])[0][0]));
    /* c8 ignore stop */
  }

  /**
   * Applies the configured `searchPath` to a new connection.
   *
   * @param connection The connection to set it on.
   * @param searchPath The path to set, or the client's own when absent.
   */
  /* Knex's own implementation, with its `connection.query(sql, callback)`
     replaced by a promise - the quoting, the array handling and the
     comma-in-a-string warning are kept identical, because what this sets is
     what every later query in Knex resolves its unqualified names against. */
  async setSchemaSearchPath(
    connection: Connection,
    searchPath?: string | string[],
  ): Promise<boolean> {
    let path = searchPath || (this as any).searchPath;
    if (!path) return true;
    if (!Array.isArray(path) && typeof path !== 'string')
      throw new TypeError(
        `knex: Expected searchPath to be Array/String, got: ${typeof path}`,
      );
    if (typeof path === 'string') {
      if (path.includes(',')) {
        const arraySyntax = `[${path
          .split(',')
          .map(part => `'${part}'`)
          .join(', ')}]`;
        this.logger.warn?.(
          `Detected comma in searchPath "${path}".` +
            `If you are trying to specify multiple schemas, use Array syntax: ${arraySyntax}`,
        );
      }
      path = [path];
    }
    const quoted = path
      .map(schemaName => `"${schemaName.replace(/"/g, '""')}"`)
      .join(',');
    await connection.query(`set search_path to ${quoted}`);
    return true;
  }

  /**
   * Runs one statement and puts its result on the query object.
   *
   * @param connection The connection to run on.
   * @param obj The statement, as Knex's runner built it.
   * @returns The same object, with `response` set.
   */
  async _query(connection: Connection, obj: QueryObject): Promise<QueryObject> {
    if (!obj.sql) throw new Error('The query is empty');
    try {
      const result = await connection.query(obj.sql, this._queryOptions(obj));
      obj.response = toQueryResult(result);
      return obj;
    } catch (error) {
      throw this._pgjsOptions.normalizeErrors ? normalizeError(error) : error;
    }
  }

  /**
   * Streams one statement's rows into the stream Knex's runner built.
   *
   * @param connection The connection to run on.
   * @param obj The statement, as Knex's runner built it.
   * @param stream Where the rows go.
   * @param options What the caller passed to `.stream()`.
   * @returns A promise that settles when the rows run out.
   */
  _stream(
    connection: Connection,
    obj: QueryObject,
    stream: NodeJS.WritableStream,
    options?: StreamOptions,
  ): Promise<void> {
    if (!obj.sql) throw new Error('The query is empty');
    const rows = createRowStream(
      connection,
      obj.sql,
      this._queryOptions(obj),
      options,
    );
    return new Promise((resolve, reject) => {
      rows.on('error', error => {
        const reported = this._pgjsOptions.normalizeErrors
          ? normalizeError(error)
          : error;
        reject(reported);
        stream.emit('error', reported);
      });
      rows.on('end', resolve);
      rows.pipe(stream);
    });
  }

  /**
   * Cancels whatever a connection is running, for Knex's query timeout.
   *
   * @param connectionToKill The connection running the statement.
   */
  /* PostgreSQL's CancelRequest travels on a connection of its own, which
     PostgreJS opens for exactly this. Knex's `pg` client instead takes a
     whole second connection out of the pool, runs `pg_cancel_backend` on it
     and closes it again - so a timeout here costs one short-lived
     connection rather than two, and never waits on a full pool. */
  async cancelQuery(connectionToKill?: Connection): Promise<void> {
    await connectionToKill?.cancel();
  }

  /**
   * Wraps a PostgreJS `Pool` passed as Knex's `connectionPool`, so Knex
   * runs on a pool the application already owns.
   *
   * @param nativePool The pool to borrow connections from.
   * @returns The three methods Knex's pool interface asks for.
   */
  /* Knex 3.3.0 and later only: earlier versions have no `connectionPool`
     and never call this. Closing the pool stays the owner's job, which is
     what Knex's own `wrapNativePool` does for `pg.Pool` too. */
  wrapNativePool(nativePool: Pool): {
    acquire(): { promise: Promise<Connection> };
    release(connection: Connection): boolean;
    destroy(): Promise<void>;
  } {
    let uid = 0;
    return {
      acquire: () => ({
        promise: nativePool.acquire().then(async connection => {
          hidePassword(connection);
          (connection as PooledConnection).__knexUid = `__knexUid${++uid}`;
          if (!this.version) {
            try {
              this.version = await this.checkVersion(connection);
              /* c8 ignore next 3 - the version is read off the connection */
            } catch {
              // The version check is best effort, as it is in Knex's own pool.
            }
          }
          return connection;
        }),
      }),
      release: connection => {
        void nativePool.release(connection);
        return true;
      },
      destroy: () => Promise.resolve(),
    };
  }

  /**
   * PostgreJS connection settings for Knex's `pg`-shaped configuration.
   *
   * @returns The translated settings, built once per configuration.
   */
  protected _connectionConfiguration(): ConnectionConfiguration {
    const settings = this.connectionSettings as Record<string, any>;
    let cached = this._connectionConfigCache;
    if (!cached || cached.source !== settings) {
      cached = {
        source: settings,
        config: toConnectionConfiguration(settings, message =>
          this.logger.warn?.(message),
        ),
      };
      this._connectionConfigCache = cached;
    }
    return cached.config;
  }

  /**
   * What PostgreJS is asked for when running one statement.
   *
   * @param obj The statement, as Knex's runner built it.
   * @returns Query options, with anything from `.options()` layered on top.
   */
  protected _queryOptions(obj: QueryObject): QueryOptions {
    const options = this._pgjsOptions;
    const extra = obj.options;
    const queryOptions: QueryOptions = {
      params: toBindParams(obj.bindings, options.inferParameterTypes),
      // Knex reads rows as objects; PostgreJS hands out arrays of values
      // unless told otherwise.
      rowDecoder: 'object',
      // PostgreSQL's own behaviour, which is what `pg` gives Knex: a failed
      // statement aborts the transaction. PostgreJS defaults to the
      // opposite, wrapping every statement in a savepoint of its own.
      rollbackOnError: options.rollbackOnError,
      prepare: options.prepare,
      typeMap: options.typeMap,
      fetchAsString: options.fetchAsString,
    };
    if (!extra) return queryOptions;
    // `.options({ rowMode: 'array' })` is how Knex spells this for `pg`.
    const { rowMode, ...rest } = extra;
    if (rowMode === 'array') queryOptions.rowDecoder = 'array';
    return Object.assign(queryOptions, rest);
  }
}

/**
 * Hides a connection's password, the way Knex hides one itself.
 *
 * @param connection The connection to hide it on.
 */
/* Knex hides the password on every connection it hands out, with
   `Object.defineProperty(connection.config, 'password', { enumerable: false,
   value })`. PostgreJS freezes its own `config`, so that call throws
   `Cannot redefine property: password` and no query ever runs.

   What replaces it is a plain copy of the configuration, carrying the same
   values, with the password already hidden in exactly the shape Knex asks
   for - a non-configurable, non-writable, non-enumerable data property of
   the same value. Redefining a property to the descriptor it already has is
   allowed, so Knex's own call then succeeds and changes nothing, on this
   acquire and on every later one.

   The password is still readable through `connection.config.password`, and
   is no longer printed by `console.log` or `JSON.stringify` - which is what
   Knex was after. */
function hidePassword(connection: Connection): void {
  const config: Record<string, any> = { ...connection.config };
  if (config.password !== undefined)
    Object.defineProperty(config, 'password', {
      value: config.password,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  Object.defineProperty(connection, 'config', {
    value: config,
    enumerable: false,
    configurable: true,
  });
}

/* Set on the prototype rather than as class fields, because Knex's base
   constructor reads `driverName` while `super()` is still running - a class
   field is assigned only after it returns.

   `driverName` stays `'pg'` on purpose, and it is not cosmetic: Knex uses
   it as the name of the SQL family rather than of the npm package, and
   `knex.fn.uuid()` switches on it, throwing `does not have a uuid function`
   for any value it does not recognise. `_packageName` is what Knex names in
   its "run npm install" message, and that one is this package's dependency. */
Object.assign(PostgrejsClient.prototype, {
  driverName: 'pg',
  _packageName: 'postgrejs',
});
