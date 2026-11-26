import { expect } from 'expect';
import type { Knex } from 'knex';
import {
  comparableResult,
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * Knex query by query, through its own `pg` client and through this one.
 *
 * Knex's own suite is the broader instrument, and it runs in CI; what it
 * asserts, though, is what its authors wrote down. This asserts that the
 * two clients answer the same thing - the rows, their types, the counts
 * and the shape of what comes back - so a difference has to be
 * deliberate to survive.
 */
describe('differential: queries', function () {
  this.timeout(120000);
  let d: Differential;
  const t = 'diff_q.users';
  const orders = 'diff_q.orders';

  before(async () => {
    d = await openDifferential('diff_q');
    d.setSchema([
      `create table ${t} (
        id serial primary key,
        name text not null,
        age int,
        salary numeric(10,2),
        meta jsonb,
        tags text[],
        active bool default true,
        created_at timestamptz default '2024-01-01T00:00:00Z'
      )`,
      `create table ${orders} (
        id serial primary key,
        user_id int references ${t}(id),
        total numeric(10,2)
      )`,
      `insert into ${t} (name, age, salary, meta, tags) values
        ('ada', 36, 1000.50, '{"role":"eng"}', '{a,b}'),
        ('grace', 45, 2000.25, '{"role":"adm"}', '{b,c}'),
        ('alan', 41, null, null, null)`,
      `insert into ${orders} (user_id, total) values (1, 10.00), (1, 20.00), (2, 30.00)`,
    ]);
  });
  after(async () => {
    await d?.close();
  });

  /** Both clients run `fn`, and their answers must match. */
  async function same<T>(fn: (db: Knex) => Promise<T>): Promise<unknown> {
    const { pg, pgjs } = await d.bothWays(async db =>
      comparableResult(await fn(db)),
    );
    expect(pgjs).toEqual(pg);
    return pg;
  }

  describe('select', () => {
    it('reads every column of every row', async () => {
      await same(db => db(t).select('*').orderBy('id'));
    });

    it('reads a subset of columns', async () => {
      await same(db => db(t).select('id', 'name').orderBy('id'));
    });

    it('answers one row for first()', async () => {
      await same(db => db(t).where('name', 'ada').first());
    });

    it('answers undefined for a first() that matches nothing', async () => {
      await same(db => db(t).where('name', 'nobody').first());
    });

    it('plucks one column', async () => {
      await same(db => db(t).orderBy('id').pluck('name'));
    });

    it('answers an empty array for a select that matches nothing', async () => {
      await same(db => db(t).where('age', 999));
    });

    it('reads a null column as null', async () => {
      await same(db => db(t).where('name', 'alan').select('salary', 'meta'));
    });

    it('applies distinct', async () => {
      await same(db => db(orders).distinct('user_id').orderBy('user_id'));
    });

    it('applies limit and offset', async () => {
      await same(db => db(t).orderBy('id').limit(2).offset(1).select('id'));
    });

    it('orders by a column descending', async () => {
      await same(db => db(t).orderBy('age', 'desc').pluck('name'));
    });
  });

  describe('where', () => {
    it('matches a string', async () => {
      await same(db => db(t).where('name', 'ada').select('id'));
    });

    it('matches a number against an integer column', async () => {
      await same(db => db(t).where('age', 36).select('id'));
    });

    it('matches a number against a numeric column', async () => {
      await same(db => db(t).where('salary', 1000.5).select('id'));
    });

    it('matches a boolean', async () => {
      await same(db => db(t).where('active', true).pluck('id'));
    });

    it('matches an object against a jsonb column', async () => {
      await same(db => db(t).where('meta', { role: 'eng' }).select('id'));
    });

    it('matches an array against an array column', async () => {
      await same(db => db(t).where('tags', ['a', 'b']).select('id'));
    });

    it('matches with whereIn', async () => {
      await same(db => db(t).whereIn('name', ['ada', 'alan']).pluck('id'));
    });

    it('matches with whereNull', async () => {
      await same(db => db(t).whereNull('salary').pluck('name'));
    });

    it('matches with whereNotNull', async () => {
      await same(db => db(t).whereNotNull('salary').pluck('name'));
    });

    it('matches with whereBetween', async () => {
      await same(db => db(t).whereBetween('age', [40, 50]).pluck('name'));
    });

    it('matches with a like pattern', async () => {
      await same(db => db(t).where('name', 'like', 'a%').pluck('name'));
    });

    it('matches with a raw json operator', async () => {
      await same(db =>
        db(t).whereRaw("meta ->> 'role' = ?", ['eng']).pluck('name'),
      );
    });

    it('matches with a subquery', async () => {
      await same(db =>
        db(t)
          .whereIn('id', inner => inner.select('user_id').from(orders))
          .pluck('name'),
      );
    });
  });

  describe('aggregates', () => {
    it('counts', async () => {
      await same(db => db(t).count('* as c'));
    });

    it('counts distinct', async () => {
      await same(db => db(orders).countDistinct('user_id as c'));
    });

    it('sums a numeric column', async () => {
      await same(db => db(t).sum('salary as s'));
    });

    it('averages', async () => {
      await same(db => db(t).avg('age as a'));
    });

    it('takes a min and a max', async () => {
      await same(db => db(t).min('age as lo').max('age as hi'));
    });

    it('groups and filters with having', async () => {
      await same(db =>
        db(orders)
          .select('user_id')
          .sum('total as total')
          .groupBy('user_id')
          .having('user_id', '>', 0)
          .orderBy('user_id'),
      );
    });
  });

  describe('joins', () => {
    it('inner joins', async () => {
      await same(db =>
        db(t)
          .join(orders, `${t}.id`, `${orders}.user_id`)
          .select(`${t}.name`, `${orders}.total`)
          .orderBy(`${orders}.id`),
      );
    });

    it('left joins, including the rows with no match', async () => {
      await same(db =>
        db(t)
          .leftJoin(orders, `${t}.id`, `${orders}.user_id`)
          .select(`${t}.name`, `${orders}.total`)
          .orderBy([`${t}.id`, `${orders}.id`]),
      );
    });
  });

  describe('insert', () => {
    it('inserts one row', async () => {
      await same(db => db(t).insert({ name: 'new', age: 1 }));
    });

    it('inserts several rows', async () => {
      await same(db =>
        db(t).insert([
          { name: 'a1', age: 1 },
          { name: 'a2', age: 2 },
        ]),
      );
    });

    it('returns the columns it was asked for', async () => {
      await same(db =>
        db(t).insert({ name: 'ret', age: 9 }).returning(['id', 'name']),
      );
    });

    it('returns every column with returning *', async () => {
      await same(db => db(t).insert({ name: 'ret2' }).returning('*'));
    });

    it('inserts a json object into a jsonb column', async () => {
      await same(db =>
        db(t)
          .insert({ name: 'js', meta: { a: 1, b: [2, 3] } })
          .returning('meta'),
      );
    });

    it('inserts an array into an array column', async () => {
      await same(db =>
        db(t)
          .insert({ name: 'arr', tags: ['x', 'y'] })
          .returning('tags'),
      );
    });

    it('inserts a Date into a timestamptz column', async () => {
      await same(db =>
        db(t)
          .insert({ name: 'dt', created_at: new Date('2024-06-01T10:00:00Z') })
          .returning('created_at'),
      );
    });

    it('inserts null', async () => {
      await same(db =>
        db(t).insert({ name: 'nil', age: null }).returning('age'),
      );
    });

    it('takes the column default for a value left undefined', async () => {
      await same(db =>
        db(t).insert({ name: 'def', age: undefined }).returning('active'),
      );
    });

    it('merges on conflict', async () => {
      await same(db =>
        db(t)
          .insert({ id: 1, name: 'ada2' })
          .onConflict('id')
          .merge()
          .returning(['id', 'name']),
      );
    });

    it('ignores on conflict', async () => {
      await same(db =>
        db(t).insert({ id: 1, name: 'ada3' }).onConflict('id').ignore(),
      );
    });
  });

  describe('update and delete', () => {
    it('counts the rows an update changed', async () => {
      await same(db => db(t).where('name', 'ada').update({ age: 37 }));
    });

    it('counts zero for an update that matched nothing', async () => {
      await same(db => db(t).where('name', 'nobody').update({ age: 1 }));
    });

    it('returns the rows an update changed', async () => {
      await same(db =>
        db(t).where('name', 'ada').update({ age: 38 }).returning(['id', 'age']),
      );
    });

    it('increments', async () => {
      await same(db => db(t).where('id', 1).increment('age', 2));
    });

    it('counts the rows a delete removed', async () => {
      await same(db => db(orders).where('user_id', 1).del());
    });

    it('returns the rows a delete removed', async () => {
      await same(db => db(orders).where('user_id', 1).del().returning('id'));
    });
  });

  describe('raw', () => {
    it('answers the same result object', async () => {
      const { pg, pgjs } = await d.bothWays(async db =>
        comparableResult(await db.raw(`select id, name from ${t} order by id`)),
      );
      expect(pgjs).toEqual(pg);
    });

    it('answers the same result object for an insert', async () => {
      const { pg, pgjs } = await d.bothWays(async db =>
        comparableResult(
          await db.raw(`insert into ${t} (name) values ('raw')`),
        ),
      );
      expect(pgjs).toEqual(pg);
    });

    it('answers the same result object for DDL', async () => {
      const { pg, pgjs } = await d.bothWays(async db =>
        comparableResult(await db.raw('create table diff_q.tmp (a int)')),
      );
      expect(pgjs).toEqual(pg);
    });

    it('binds parameters the same way', async () => {
      const { pg, pgjs } = await d.bothWays(async db =>
        comparableResult(
          await db.raw(`select * from ${t} where name = ? and age > ?`, [
            'ada',
            1,
          ]),
        ),
      );
      expect(pgjs).toEqual(pg);
    });

    it('carries the keys pg carries, plus the whole command tag', async () => {
      const { pg, pgjs } = await d.bothWays(async db => {
        const result: any = await db.raw('select 1 as a');
        return Object.keys(result).sort();
      });
      // `pg` also exposes its own parser tables and two legacy fields; what
      // a caller reads is the four this client answers with, plus the whole
      // command tag, which `pg` throws away.
      expect(pgjs).toEqual([
        'command',
        'commandTag',
        'fields',
        'rowCount',
        'rows',
      ]);
      for (const key of ['command', 'fields', 'rowCount', 'rows'])
        expect(pg).toContain(key);
    });

    it('names each column the same way', async () => {
      const { pg, pgjs } = await d.bothWays(async db => {
        const result = await db.raw(`select id, name from ${t} limit 1`);
        return result.fields.map((field: any) => ({
          name: field.name,
          dataTypeID: field.dataTypeID,
          tableID: typeof field.tableID,
          dataTypeSize: field.dataTypeSize,
          dataTypeModifier: field.dataTypeModifier,
        }));
      });
      expect(pgjs).toEqual(pg);
    });
  });

  describe('schema builder', () => {
    it('builds and reads back a table', async () => {
      await same(async db => {
        await db.schema.withSchema('diff_q').createTable('built', table => {
          table.increments('id');
          table.string('name', 20).notNullable();
          table.integer('n').defaultTo(7);
          table.boolean('flag').defaultTo(false);
          table.jsonb('doc');
          table.timestamps(true, true);
          table.unique(['name']);
        });
        await db('diff_q.built').insert({ name: 'x', doc: { a: 1 } });
        const selected = await db('diff_q.built').select(
          'name',
          'n',
          'flag',
          'doc',
        );
        const exists = await db.schema.withSchema('diff_q').hasTable('built');
        const hasColumn = await db.schema
          .withSchema('diff_q')
          .hasColumn('built', 'doc');
        const info = await db('diff_q.built').columnInfo();
        return { selected, exists, hasColumn, info };
      });
    });

    it('alters a table', async () => {
      await same(async db => {
        await db.schema.withSchema('diff_q').createTable('alt', table => {
          table.increments('id');
          table.string('a');
        });
        await db.schema.withSchema('diff_q').alterTable('alt', table => {
          table.renameColumn('a', 'b');
          table.integer('c');
        });
        return db('diff_q.alt').columnInfo();
      });
    });

    it('drops a table', async () => {
      await same(async db => {
        await db.schema.withSchema('diff_q').createTable('gone', table => {
          table.increments('id');
        });
        await db.schema.withSchema('diff_q').dropTable('gone');
        return db.schema.withSchema('diff_q').hasTable('gone');
      });
    });
  });

  describe('common table expressions and unions', () => {
    it('runs a CTE', async () => {
      await same(db =>
        db
          .with('adults', qb => qb.from(t).where('age', '>', 40).select('name'))
          .from('adults')
          .orderBy('name'),
      );
    });

    it('runs a union', async () => {
      await same(db =>
        db(t)
          .select('name')
          .where('age', 36)
          .union(qb => qb.select('name').from(t).where('age', 45))
          .orderBy('name'),
      );
    });
  });
});
