import { expect } from 'expect';
import {
  comparableResult,
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * What a parameter means, through Knex's own `pg` client and through this
 * one.
 *
 * A declared type is one PostgreSQL will not coerce, so the cases that
 * matter are the ones where a parameter's type is resolved from its
 * surroundings rather than from its value. `src/params.ts` says which
 * values are bound untyped and why; this is what proves it, including
 * the one place where matching `pg` means losing information.
 */
describe('differential: parameters', function () {
  this.timeout(120000);
  let d: Differential;
  const t = 'diff_p.t';

  before(async () => {
    d = await openDifferential('diff_p');
    d.setSchema([
      `create table ${t} (
        id int, jb jsonb, j json, txt text, n numeric, i4 int,
        i8 bigint, b bool, d date, tz timestamptz, arr int[], barr bool[], by bytea
      )`,
      `insert into ${t} values (
        1, '{"a":1}', '{"a":1}', '42', 12.34, 42, 9007199254740993, true,
        '2024-03-05', '2024-03-05T12:30:00Z', '{1,2,3}', '{true,false}', '\\x6869'
      )`,
    ]);
  });
  after(async () => {
    await d?.close();
  });

  /** The same `knex.raw` on both clients, compared. */
  async function same(sql: string, bindings: readonly any[]): Promise<unknown> {
    const { pg, pgjs } = await d.bothWays(async db =>
      comparableResult(await db.raw(sql, bindings as any[])),
    );
    expect(pgjs).toEqual(pg);
    return pg;
  }

  describe('a parameter resolved from where it appears', () => {
    it('compares a number against a text column', async () => {
      await same(`select id from ${t} where txt = ?`, [42]);
    });

    it('coalesces a number with a text column', async () => {
      await same(`select coalesce(?, txt) as v from ${t}`, [7]);
    });

    it('compares an object against a jsonb column', async () => {
      await same(`select id from ${t} where jb = ?`, [{ a: 1 }]);
    });

    it('contains an object in a jsonb column', async () => {
      await same(`select id from ${t} where jb @> ?`, [{ a: 1 }]);
    });

    it('compares a string against an integer column', async () => {
      await same(`select id from ${t} where i4 = ?`, ['42']);
    });

    it('takes the greatest of a number and an integer column', async () => {
      await same(`select greatest(?, i4) as v from ${t}`, [7]);
    });

    it('adds one to a number', async () => {
      await same('select ? + 1 as v', [5]);
    });

    it('casts a number to text', async () => {
      await same('select (?)::text as v', [5]);
    });

    it('branches on a boolean', async () => {
      await same('select case when ? then 1 else 2 end as v', [true]);
    });

    it('limits by a number', async () => {
      await same(`select id from ${t} limit ?`, [1]);
    });
  });

  describe('a value PostgreJS types itself', () => {
    it('compares a Date against a date column', async () => {
      await same(`select id from ${t} where d = ?`, [
        new Date('2024-03-05T00:00:00Z'),
      ]);
    });

    it('compares a Date against a timestamptz column', async () => {
      await same(`select id from ${t} where tz = ?`, [
        new Date('2024-03-05T12:30:00Z'),
      ]);
    });

    it('compares a Buffer against a bytea column', async () => {
      await same(`select id from ${t} where by = ?`, [Buffer.from('hi')]);
    });

    it('compares an array against an integer array column', async () => {
      await same(`select id from ${t} where arr = ?`, [[1, 2, 3]]);
    });

    it('compares an array against a boolean array column', async () => {
      await same(`select id from ${t} where barr = ?`, [[true, false]]);
    });

    it('matches any of an array', async () => {
      await same(`select id from ${t} where id = any(?)`, [[1, 2, 3]]);
    });

    it('compares a bigint against a bigint column', async () => {
      await same(`select id from ${t} where i8 = ?`, [9007199254740993n]);
    });

    it('compares a number against a numeric column', async () => {
      await same(`select id from ${t} where n = ?`, [12.34]);
    });
  });

  describe('null', () => {
    it('is not distinct from a null column', async () => {
      await same(
        `select count(*)::int as v from ${t} where txt is not distinct from ?`,
        [null],
      );
    });

    it('never equals an integer column', async () => {
      await same(`select count(*)::int as v from ${t} where i4 = ?`, [null]);
    });

    it('inserts as null', async () => {
      await same(`insert into ${t} (txt) values (?) returning txt`, [null]);
    });
  });

  describe('writing', () => {
    it('inserts a number into a numeric column', async () => {
      await same(`insert into ${t} (n) values (?) returning n`, [1.5]);
    });

    it('inserts a string into an integer column', async () => {
      await same(`insert into ${t} (i4) values (?) returning i4`, ['7']);
    });

    it('inserts an object into a jsonb column', async () => {
      await same(`insert into ${t} (jb) values (?) returning jb`, [
        { a: 1, b: [2] },
      ]);
    });

    it('inserts a Date into a date column', async () => {
      await same(`insert into ${t} (d) values (?) returning d`, [
        new Date('2024-03-05T12:30:00Z'),
      ]);
    });

    it('inserts an array into an array column', async () => {
      await same(`insert into ${t} (arr) values (?) returning arr`, [[4, 5]]);
    });
  });

  describe('what matching pg costs', () => {
    it('answers a string for a parameter with no context, as pg does', async () => {
      const value = await same('select ? as v', [5]);
      expect(value).toEqual({
        command: 'SELECT',
        rowCount: 1,
        rows: [{ v: '5' }],
      });
    });

    it('keeps the number when parameter types are left to PostgreJS', async () => {
      const { openKnex } = await import('../_support/live.js');
      const db = openKnex({ inferParameterTypes: false });
      try {
        const result = await db.raw('select ? as v', [5]);
        expect(result.rows[0].v).toBe(5);
      } finally {
        await db.destroy();
      }
    });
  });
});
