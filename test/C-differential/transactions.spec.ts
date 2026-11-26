import { expect } from 'expect';
import {
  comparableResult,
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * Transactions, through Knex's own `pg` client and through this one.
 *
 * PostgreJS wraps every statement in a savepoint of its own by default,
 * so one failed statement would leave a transaction usable - which is
 * neither PostgreSQL's behaviour nor what any Knex code expects. The
 * client turns that off on every query, and this is what holds it to it.
 */
describe('differential: transactions', function () {
  this.timeout(120000);
  let d: Differential;
  const t = 'diff_t.t';

  before(async () => {
    d = await openDifferential('diff_t');
    d.setSchema([
      `create table ${t} (id int primary key, name text)`,
      `insert into ${t} values (1, 'one')`,
    ]);
  });
  after(async () => {
    await d?.close();
  });

  it('commits what a transaction did', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      await db.transaction(async trx => {
        await trx(t).insert({ id: 2, name: 'two' });
      });
      return comparableResult(await db(t).orderBy('id'));
    });
    expect(pgjs).toEqual(pg);
  });

  it('rolls back everything when the body throws', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      const thrown = await db
        .transaction(async trx => {
          await trx(t).insert({ id: 3, name: 'three' });
          throw new Error('deliberate');
        })
        .catch((error: Error) => error.message);
      return {
        thrown,
        rows: comparableResult(await db(t).orderBy('id')),
      };
    });
    expect(pgjs).toEqual(pg);
  });

  it('aborts the transaction after a failed statement', async () => {
    const { pg, pgjs } = await d.bothWays(async db =>
      db.transaction(async trx => {
        // A duplicate key, which PostgreSQL answers by aborting the whole
        // transaction - every later statement is refused until a rollback.
        const first = await trx(t)
          .insert({ id: 1, name: 'clash' })
          .catch((error: any) => error.code);
        const second = await trx
          .raw('select 1 as v')
          .then(() => 'accepted')
          .catch((error: any) => error.code);
        return { first, second };
      }),
    );
    expect(pgjs).toEqual(pg);
    expect(pgjs).toEqual({ first: '23505', second: '25P02' });
  });

  it('keeps a savepoint that rolled back from taking the rest with it', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      await db.transaction(async trx => {
        await trx(t).insert({ id: 4, name: 'four' });
        await trx
          .transaction(async inner => {
            await inner(t).insert({ id: 5, name: 'five' });
            throw new Error('inner');
          })
          .catch(() => undefined);
        await trx(t).insert({ id: 6, name: 'six' });
      });
      return comparableResult(await db(t).orderBy('id'));
    });
    expect(pgjs).toEqual(pg);
  });

  it('runs an isolation level the same way', async () => {
    const { pg, pgjs } = await d.bothWays(async db =>
      db.transaction(
        async trx => {
          const level = await trx.raw('show transaction_isolation');
          return comparableResult(level);
        },
        { isolationLevel: 'serializable' },
      ),
    );
    expect(pgjs).toEqual(pg);
  });

  it('runs a read-only transaction the same way', async () => {
    const { pg, pgjs } = await d.bothWays(async db =>
      db
        .transaction(
          async trx => {
            await trx(t).insert({ id: 9, name: 'nine' });
            return 'accepted';
          },
          { readOnly: true },
        )
        .catch((error: any) => error.code),
    );
    expect(pgjs).toEqual(pg);
    expect(pgjs).toBe('25006');
  });

  it('sends the same statements in the same order', async () => {
    const { pg, pgjs } = await d.bothWays(async db => {
      const statements: string[] = [];
      const listener = (query: any) => statements.push(query.sql);
      db.on('query', listener);
      try {
        await db.transaction(async trx => {
          await trx(t).insert({ id: 7, name: 'seven' });
          await trx.transaction(async inner => {
            await inner(t).insert({ id: 8, name: 'eight' });
          });
        });
      } finally {
        db.removeListener('query', listener);
      }
      // Knex numbers savepoints from a counter that runs for the whole
      // process, so the number differs between the two runs and says
      // nothing about either client.
      return statements.map(statement => statement.replace(/trx\d+/g, 'trxN'));
    });
    expect(pgjs).toEqual(pg);
  });
});
