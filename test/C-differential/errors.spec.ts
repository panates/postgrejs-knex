import { expect } from 'expect';
import {
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * What a failing query throws, through Knex's own `pg` client and through
 * this one.
 *
 * Knex prepends the compiled statement to whatever message it is handed,
 * so a message that differs is a message every Knex user sees differ.
 */
describe('differential: errors', function () {
  this.timeout(120000);
  let d: Differential;
  const t = 'diff_e.t';

  before(async () => {
    d = await openDifferential('diff_e');
    d.setSchema([
      `create table ${t} (id int primary key, name text not null, n int check (n > 0))`,
      `insert into ${t} values (1, 'one', 1)`,
    ]);
  });
  after(async () => {
    await d?.close();
  });

  /** The fields of whatever `fn` throws, on both clients. */
  async function thrownBy(fn: (db: any) => Promise<unknown>) {
    return d.bothWays(async db => {
      try {
        await fn(db);
        return { threw: false };
      } catch (error: any) {
        return {
          threw: true,
          code: error.code,
          message: error.message,
          severity: error.severity,
          constraint: error.constraint,
          detail: error.detail,
          table: error.table,
          column: error.column,
          schema: error.schema,
          positionType: typeof error.position,
          lines: String(error.message).split('\n').length,
        };
      }
    });
  }

  it('reports a unique violation the same way', async () => {
    const { pg, pgjs } = await thrownBy(db =>
      db(t).insert({ id: 1, name: 'clash', n: 1 }),
    );
    expect(pgjs).toEqual(pg);
    expect((pgjs as any).code).toBe('23505');
  });

  it('reports a not-null violation the same way', async () => {
    const { pg, pgjs } = await thrownBy(db =>
      db(t).insert({ id: 2, name: null, n: 1 }),
    );
    expect(pgjs).toEqual(pg);
  });

  it('reports a check violation the same way', async () => {
    const { pg, pgjs } = await thrownBy(db =>
      db(t).insert({ id: 3, name: 'x', n: -1 }),
    );
    expect(pgjs).toEqual(pg);
  });

  it('reports an undefined table the same way', async () => {
    const { pg, pgjs } = await thrownBy(db => db('diff_e.nope').select('*'));
    expect(pgjs).toEqual(pg);
    expect((pgjs as any).code).toBe('42P01');
  });

  it('reports an undefined column the same way', async () => {
    const { pg, pgjs } = await thrownBy(db => db(t).select('nope'));
    expect(pgjs).toEqual(pg);
  });

  it('reports a syntax error the same way, on one line', async () => {
    const { pg, pgjs } = await thrownBy(db => db.raw('select from from'));
    expect(pgjs).toEqual(pg);
    expect((pgjs as any).lines).toBe(1);
  });

  it('reports a division by zero the same way', async () => {
    const { pg, pgjs } = await thrownBy(db => db.raw('select 1/0'));
    expect(pgjs).toEqual(pg);
  });

  it('puts the compiled statement in front, as Knex always has', async () => {
    const { pgjs } = await thrownBy(db =>
      db(t).insert({ id: 1, name: 'clash', n: 1 }),
    );
    expect((pgjs as any).message).toContain('insert into');
  });
});
