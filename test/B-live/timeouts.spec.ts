import { expect } from 'expect';
import { type LiveDb, openLiveDb } from '../_support/live.js';

describe('live: timeouts and cancellation', function () {
  this.timeout(60000);
  let live: LiveDb;

  before(async () => {
    live = await openLiveDb('live_timeout');
  });
  after(async () => {
    await live?.close();
  });

  it('cancels the statement on the server when asked to', async () => {
    const before = await runningSleeps(live.db);
    const error = await live.db
      .raw('select pg_sleep(10)')
      .timeout(300, { cancel: true })
      .catch((e: any) => e);
    expect(error.name).toBe('KnexTimeoutError');
    // The cancel travels on its own connection, so the statement is gone
    // by the time the timeout rejects rather than running to completion.
    expect(await runningSleeps(live.db)).toBeLessThanOrEqual(before);
  });

  it('leaves the connection usable after a cancelled statement', async () => {
    await live.db
      .raw('select pg_sleep(10)')
      .timeout(300, { cancel: true })
      .catch(() => undefined);
    const result = await live.db.raw('select 1 as v');
    expect(result.rows[0].v).toBe(1);
  });

  it('times out without cancelling when it was not asked to', async () => {
    const error = await live.db
      .raw('select pg_sleep(1)')
      .timeout(200)
      .catch((e: any) => e);
    expect(error.name).toBe('KnexTimeoutError');
  });

  it('does not cancel a statement that already finished', async () => {
    await live.db.raw('select 1').timeout(5000, { cancel: true });
    const result = await live.db.raw('select 2 as v');
    expect(result.rows[0].v).toBe(2);
  });
});

/** How many `pg_sleep` statements this database is running. */
async function runningSleeps(db: any): Promise<number> {
  const result = await db.raw(
    `select count(*)::int as c from pg_stat_activity
     where datname = current_database() and query like 'select pg_sleep%'
       and state = 'active'`,
  );
  return result.rows[0].c;
}
