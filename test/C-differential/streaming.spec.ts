import { expect } from 'expect';
import {
  comparable,
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * Streaming, through Knex's own `pg` client and through this one.
 *
 * `pg` streams with `pg-query-stream`, which drives a `pg-cursor` over
 * `pg`'s internal protocol object; this client opens a PostgreJS cursor
 * and reads it a batch at a time. Nothing above either of them should be
 * able to tell.
 */
describe('differential: streaming', function () {
  this.timeout(120000);
  let d: Differential;
  const t = 'diff_s.rows';

  before(async () => {
    d = await openDifferential('diff_s');
    d.setSchema([
      `create table ${t} as
       select g as id, 'row ' || g as name, (g % 2 = 0) as even
       from generate_series(1, 500) g`,
    ]);
  });
  after(async () => {
    await d?.close();
  });

  it('streams the same rows', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      const rows: unknown[] = [];
      for await (const row of db(t).orderBy('id').stream({ batchSize: 50 }))
        rows.push(comparable(row));
      return rows;
    });
    expect(pgjs).toEqual(pg);
  });

  it('streams the same rows through a handler', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      const rows: unknown[] = [];
      await db(t)
        .orderBy('id')
        .limit(10)
        .stream(stream => {
          stream.on('data', (row: unknown) => rows.push(comparable(row)));
        });
      return rows;
    });
    expect(pgjs).toEqual(pg);
  });

  it('hands back the same arrays in rowMode array', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      const rows: unknown[] = [];
      for await (const row of db(t)
        .orderBy('id')
        .limit(3)
        .stream({ rowMode: 'array' }))
        rows.push(comparable(row));
      return rows;
    });
    expect(pgjs).toEqual(pg);
  });

  it('stops at the same place when the consumer breaks off', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      const rows: unknown[] = [];
      for await (const row of db(t).orderBy('id').stream({ batchSize: 10 })) {
        rows.push(comparable(row));
        if (rows.length === 5) break;
      }
      // The connection went back to the pool rather than staying open
      // mid-result, which is what the count proves.
      const count = await db(t).count('* as c');
      return { rows, count: comparable(count) };
    });
    expect(pgjs).toEqual(pg);
  });

  it('reports the same error', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      try {
        for await (const row of db.raw('select * from diff_s.nope').stream())
          if (row) break;
        return { threw: false };
      } catch (error: any) {
        return { threw: true, code: error.code };
      }
    });
    expect(pgjs).toEqual(pg);
    expect((pgjs as any).code).toBe('42P01');
  });
});
