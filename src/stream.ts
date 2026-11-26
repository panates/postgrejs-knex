import { Readable } from 'node:stream';
import type { Connection, Cursor, QueryOptions } from 'postgrejs';

/** How many rows one fetch asks the server for, when nothing says. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * The options Knex forwards to `_stream`, which are `pg-query-stream`'s.
 *
 * @see {@link https://github.com/brianc/node-postgres/tree/master/packages/pg-query-stream}
 */
export interface StreamOptions {
  /** How many rows one round trip fetches. */
  batchSize?: number;
  /** How many rows the readable side buffers. */
  highWaterMark?: number;
  /** `'array'` hands each row back as an array of values. */
  rowMode?: 'array';
}

/**
 * A readable stream of rows, over a PostgreJS cursor.
 *
 * @param connection The connection to run on, held until the stream ends.
 * @param sql The statement to run.
 * @param queryOptions Parameters and decoding, as the client built them.
 * @param options What Knex's caller passed to `.stream()`.
 * @returns A paused object-mode stream of rows.
 */
/* A real `Readable` rather than rows pushed into Knex's own transform,
   because Knex's runner is built around `pg`'s stream being one: it listens
   for `'pipe'` to learn what the source is, and destroys that source when
   the consumer closes early. Piping a `Readable` in keeps every one of
   those paths working unchanged, and gets backpressure for nothing - the
   cursor is only asked for the next row when the consumer is ready for it,
   so a result larger than memory streams through rather than piling up. */
export function createRowStream(
  connection: Connection,
  sql: string,
  queryOptions: QueryOptions,
  options: StreamOptions = {},
): Readable {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let portal: Cursor | undefined;
  let opening: Promise<Cursor> | undefined;

  const open = (): Promise<Cursor> => {
    if (!opening)
      opening = connection
        .query(sql, {
          ...queryOptions,
          rowDecoder: options.rowMode === 'array' ? 'array' : 'object',
          cursor: true,
          // One round trip per batch rather than per row: the cursor fetches
          // this many at a time and hands them out one by one.
          fetchCount: batchSize,
        })
        .then(result => {
          /* c8 ignore next - `cursor: true` always produces one */
          if (!result.cursor) throw new Error('Server did not return a cursor');
          portal = result.cursor;
          return portal;
        });
    return opening;
  };

  return new Readable({
    objectMode: true,
    highWaterMark: options.highWaterMark ?? batchSize,
    read() {
      open()
        .then(cursor => cursor.next())
        .then(row => this.push(row === undefined ? null : row))
        .catch(error => this.destroy(error as Error));
    },
    destroy(error, callback) {
      // Closes however the stream ended - rows exhausted, consumer gone, or
      // a throw. A cursor that never opened has nothing to release.
      if (!portal) return callback(error);
      portal.close().then(
        () => callback(error),
        () => callback(error),
      );
    },
  });
}
