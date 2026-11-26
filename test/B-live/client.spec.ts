import { expect } from 'expect';
import Knex from 'knex';
import { Connection } from 'postgrejs';
import { PostgrejsClient } from '../../src/index.js';
import {
  connectionSettings,
  type LiveDb,
  openKnex,
  openLiveDb,
  openPool,
} from '../_support/live.js';

describe('live: client', function () {
  this.timeout(60000);
  let live: LiveDb;

  before(async () => {
    live = await openLiveDb('live_client');
    await live.db.schema.withSchema('live_client').createTable('t', table => {
      table.increments('id');
      table.string('name');
    });
    await live.db('live_client.t').insert([{ name: 'a' }, { name: 'b' }]);
  });
  after(async () => {
    await live?.close();
  });

  it('reads the server version without a round trip of its own', async () => {
    expect((live.db.client as any).version).toMatch(/^\d+/);
  });

  it('answers gen_random_uuid() for knex.fn.uuid()', async () => {
    // Knex switches on `driverName` here, and throws for a name it does
    // not know - which is why this client keeps `pg`.
    const result = await live.db.raw('select ? as v', [live.db.fn.uuid()]);
    expect(result.rows[0].v).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('hands the PostgreJS connection through, for what Knex cannot do', async () => {
    const seen: string[] = [];
    await live.db.client.acquireConnection().then(async (connection: any) => {
      expect(connection).toBeInstanceOf(Connection);
      await connection.listen('live_client_channel', (message: any) =>
        seen.push(message.payload),
      );
      await connection.query("notify live_client_channel, 'hello'");
      await new Promise(resolve => setTimeout(resolve, 100));
      await connection.unListenAll();
      await live.db.client.releaseConnection(connection);
    });
    expect(seen).toEqual(['hello']);
  });

  it('keeps the password usable while keeping it out of logs', async () => {
    // Knex hides the password with a non-enumerable property before the
    // settings reach a client, and hides it again on every connection it
    // hands out. Both broke here once: the first dropped the password from
    // the connection, the second threw on PostgreJS's frozen config.
    const connection: any = await live.db.client.acquireConnection();
    try {
      expect(connection.config.password).toBe(process.env.PGPASSWORD);
      expect(Object.keys(connection.config)).not.toContain('password');
      expect(JSON.parse(JSON.stringify(connection.config))).not.toHaveProperty(
        'password',
      );
      // The same connection, acquired again, is what used to throw.
      await live.db.client.releaseConnection(connection);
      const again = await live.db.client.acquireConnection();
      await live.db.client.releaseConnection(again);
    } finally {
      await live.db('live_client.t').select('id');
    }
  });

  it('marks a connection the pool should drop when it errors', async () => {
    const connection: any = await live.db.client.acquireConnection();
    try {
      expect(connection.__knex__disposed).toBeUndefined();
      connection.emit('error', new Error('socket gone'));
      expect(connection.__knex__disposed).toEqual(new Error('socket gone'));
      expect(await live.db.client.validateConnection(connection)).toBe(true);
    } finally {
      await live.db.client.releaseConnection(connection);
    }
  });

  it('marks a connection the pool should drop when it closes', async () => {
    const db = openKnex(undefined, { pool: { min: 0, max: 1 } });
    try {
      const connection: any = await db.client.acquireConnection();
      await connection.close();
      expect(connection.__knex__disposed).toBe('Connection ended unexpectedly');
      await db.client.releaseConnection(connection);
      // The pool validates on the way out and builds a replacement, so the
      // next query runs on a live connection rather than the dead one.
      expect((await db.raw('select 1 as v')).rows[0].v).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('connects from a connection string', async () => {
    const { host, port, user, password, database } = connectionSettings();
    const db = Knex({
      client: PostgrejsClient as any,
      connection: `postgres://${user}:${password}@${host}:${port}/${database}`,
      pool: { min: 0, max: 2 },
    } as any);
    try {
      const result = await db.raw('select 1 as v');
      expect(result.rows[0].v).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('applies a configured searchPath', async () => {
    const db = openKnex(undefined, { searchPath: ['live_client', 'public'] });
    try {
      const result = await db.raw('show search_path');
      expect(result.rows[0].search_path).toContain('live_client');
      // An unqualified name now resolves inside that schema.
      expect(await db('t').count('* as c')).toEqual([{ c: '2' }]);
    } finally {
      await db.destroy();
    }
  });

  it('runs a pool afterCreate hook on each new connection', async () => {
    let created = 0;
    const db = openKnex(undefined, {
      pool: {
        min: 0,
        max: 1,
        afterCreate: (connection: any, done: any) => {
          created++;
          connection
            .query("set application_name to 'knex-postgrejs-test'")
            .then(() => done(null, connection), done);
        },
      },
    } as any);
    try {
      const result = await db.raw('show application_name');
      expect(result.rows[0].application_name).toBe('knex-postgrejs-test');
      expect(created).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('closes every connection when the Knex instance is destroyed', async () => {
    const db = openKnex();
    await db.raw('select 1');
    const before = await countBackends(live.db);
    await db.destroy();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await countBackends(live.db)).toBeLessThan(before);
  });

  it('decodes natively when asked to', async () => {
    const db = openKnex({ decoding: 'native' });
    try {
      const result = await db.raw(
        'select 9007199254740993::int8 as big, 12.34::numeric as n',
      );
      expect(result.rows[0].big).toBe(9007199254740993n);
      expect(typeof result.rows[0].n).not.toBe('string');
    } finally {
      await db.destroy();
    }
  });

  it('runs without the prepared statement cache when asked to', async () => {
    const db = openKnex({ prepare: false });
    try {
      for (let i = 0; i < 3; i++)
        expect((await db.raw('select ?::int as v', [i])).rows[0].v).toBe(i);
      const prepared = await db.raw(
        'select count(*)::int as c from pg_prepared_statements',
      );
      expect(prepared.rows[0].c).toBe(0);
    } finally {
      await db.destroy();
    }
  });

  it('says so rather than dropping a pg option it cannot honour', async () => {
    const warnings: string[] = [];
    const db = openKnex(undefined, {
      connection: { ...connectionSettings(), statement_timeout: 1000 },
      log: { warn: (message: string) => warnings.push(message) },
    } as any);
    try {
      await db.raw('select 1');
      expect(warnings.some(w => w.includes('statement_timeout'))).toBe(true);
    } finally {
      await db.destroy();
    }
  });
});

/** How many backends this database currently has. */
async function countBackends(db: any): Promise<number> {
  const result = await db.raw(
    'select count(*)::int as c from pg_stat_activity where datname = current_database()',
  );
  return result.rows[0].c;
}

describe('live: an external PostgreJS pool', function () {
  this.timeout(60000);

  it('runs Knex on a pool the application owns', async () => {
    const pool = openPool();
    const db = Knex({
      client: PostgrejsClient as any,
      connectionPool: pool,
    } as any);
    try {
      const result = await db.raw('select 1 as v');
      expect(result.rows[0].v).toBe(1);
      expect((db.client as any).version).toMatch(/^\d+/);
    } finally {
      await db.destroy();
      // Knex does not own the pool, so it is still usable after destroy().
      const connection = await pool.acquire();
      await pool.release(connection);
      await pool.close();
    }
  });

  it('runs a transaction on it', async () => {
    const pool = openPool();
    const db = Knex({
      client: PostgrejsClient as any,
      connectionPool: pool,
    } as any);
    try {
      const value = await db.transaction(async trx => {
        const result = await trx.raw('select 42 as v');
        return result.rows[0].v;
      });
      expect(value).toBe(42);
    } finally {
      await db.destroy();
      await pool.close();
    }
  });
});
