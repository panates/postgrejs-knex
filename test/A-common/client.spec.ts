import { expect } from 'expect';
import type { QueryOptions } from 'postgrejs';
import { BindParam, ConnectionState } from 'postgrejs';
import {
  FETCH_AS_STRING_OIDS,
  PostgrejsClient,
  type PostgrejsOptions,
} from '../../src/index.js';
import { FakeConnection, FakePool } from '../_support/fakes.js';

/** A client with no pool, so nothing reaches a server. */
function makeClient(postgrejs?: PostgrejsOptions): any {
  return new PostgrejsClient({
    client: PostgrejsClient,
    connection: { host: '127.0.0.1', database: 'test' },
    pool: { max: 0 },
    ...(postgrejs ? { postgrejs } : {}),
  } as any);
}

/** The options one query went out with. */
async function optionsOf(
  client: any,
  obj: any,
  connection = new FakeConnection(),
): Promise<QueryOptions> {
  await client._query(connection.asConnection(), obj);
  return connection.queries[0].options!;
}

describe('client', () => {
  describe('identity', () => {
    it('keeps driverName pg, which knex.fn.uuid() switches on', () => {
      expect(makeClient().driverName).toBe('pg');
    });

    it('names postgrejs as the package to install', () => {
      expect(makeClient()._packageName).toBe('postgrejs');
    });

    it('hands PostgreJS itself back as the driver', () => {
      expect(makeClient()._driver().Connection).toBeDefined();
    });
  });

  describe('query options', () => {
    it('asks for object rows, which is what Knex reads', async () => {
      const options = await optionsOf(makeClient(), { sql: 'select 1' });
      expect(options.rowDecoder).toBe('object');
    });

    it('aborts a transaction on error, as pg and PostgreSQL do', async () => {
      const options = await optionsOf(makeClient(), { sql: 'select 1' });
      expect(options.rollbackOnError).toBe(false);
    });

    it('asks for the pg decoding list by default', async () => {
      const options = await optionsOf(makeClient(), { sql: 'select 1' });
      expect(options.fetchAsString).toBe(FETCH_AS_STRING_OIDS);
    });

    it('asks for nothing as text under native decoding', async () => {
      const options = await optionsOf(makeClient({ decoding: 'native' }), {
        sql: 'select 1',
      });
      expect(options.fetchAsString).toBeUndefined();
    });

    it('passes prepare through when it was configured', async () => {
      const options = await optionsOf(makeClient({ prepare: false }), {
        sql: 'select 1',
      });
      expect(options.prepare).toBe(false);
    });

    it('binds parameters the way pg sends them', async () => {
      const options = await optionsOf(makeClient(), {
        sql: 'select ?',
        bindings: [42],
      });
      expect(options.params![0]).toBeInstanceOf(BindParam);
      expect((options.params![0] as BindParam).oid).toBe(0);
    });

    it('sends no parameters for a statement that has none', async () => {
      const options = await optionsOf(makeClient(), { sql: 'select 1' });
      expect(options.params).toBeUndefined();
    });

    it("reads Knex's own rowMode option", async () => {
      const options = await optionsOf(makeClient(), {
        sql: 'select 1',
        options: { rowMode: 'array' },
      });
      expect(options.rowDecoder).toBe('array');
    });

    it('layers anything else from .options() on top', async () => {
      const options = await optionsOf(makeClient(), {
        sql: 'select 1',
        options: { prepare: false, columnFormat: 1 },
      });
      expect(options.prepare).toBe(false);
      expect(options.columnFormat).toBe(1);
    });
  });

  describe('results', () => {
    it("puts pg's own result shape on the query object", async () => {
      const client = makeClient();
      const connection = new FakeConnection();
      connection.queryResult = {
        command: 'SELECT',
        rows: [{ a: 1 }],
      } as any;
      const obj: any = { sql: 'select 1' };
      await client._query(connection.asConnection(), obj);
      expect(obj.response).toEqual({
        command: 'SELECT',
        commandTag: 'SELECT',
        rowCount: 1,
        rows: [{ a: 1 }],
        fields: [],
      });
    });

    it('refuses an empty statement', async () => {
      await expect(
        makeClient()._query(new FakeConnection().asConnection(), { sql: '' }),
      ).rejects.toThrow('The query is empty');
    });

    it('normalizes an error by default', async () => {
      const client = makeClient();
      const connection = new FakeConnection();
      const error: any = new Error('decorated\n  ^');
      error.serverMessage = 'plain';
      error.position = 3;
      connection.queryResult = error;
      await expect(
        client._query(connection.asConnection(), { sql: 'select 1' }),
      ).rejects.toMatchObject({ message: 'plain', position: '3' });
    });

    it('leaves the error alone when asked to', async () => {
      const client = makeClient({ normalizeErrors: false });
      const connection = new FakeConnection();
      const error: any = new Error('decorated\n  ^');
      error.serverMessage = 'plain';
      connection.queryResult = error;
      await expect(
        client._query(connection.asConnection(), { sql: 'select 1' }),
      ).rejects.toMatchObject({ message: 'decorated\n  ^' });
    });
  });

  describe('the client of a transaction', () => {
    it('reads its options from config, which is all Knex copies', async () => {
      const client = makeClient({ decoding: 'native' });
      // What `makeTxClient` builds: no constructor runs, and only a handful
      // of named fields are carried over.
      const trxClient: any = Object.create(client.constructor.prototype);
      trxClient.config = client.config;
      trxClient.logger = client.logger;
      const options = await optionsOf(trxClient, { sql: 'select 1' });
      expect(options.fetchAsString).toBeUndefined();
      expect(options.rowDecoder).toBe('object');
    });
  });

  describe('connections', () => {
    it('closes a connection the pool has finished with', async () => {
      const connection = new FakeConnection();
      await makeClient().destroyRawConnection(connection.asConnection());
      expect(connection.calls.map(c => c.method)).toEqual(['close']);
    });

    it('accepts a connection that is still ready', async () => {
      const connection = new FakeConnection();
      expect(
        await makeClient().validateConnection(connection.asConnection()),
      ).toBe(true);
    });

    it('rejects a connection that is not', async () => {
      const connection = new FakeConnection();
      connection.state = ConnectionState.CLOSED;
      expect(
        await makeClient().validateConnection(connection.asConnection()),
      ).toBe(false);
    });

    it('reads the version off the connection rather than asking', async () => {
      const connection = new FakeConnection();
      expect(await makeClient().checkVersion(connection.asConnection())).toBe(
        '18.6',
      );
      expect(connection.queries).toHaveLength(0);
    });

    it('cancels out of band, without taking a second pooled connection', async () => {
      const connection = new FakeConnection();
      await makeClient().cancelQuery(connection.asConnection());
      expect(connection.calls.map(c => c.method)).toEqual(['cancel']);
    });
  });

  describe('search path', () => {
    it('does nothing when none is configured', async () => {
      const connection = new FakeConnection();
      expect(
        await makeClient().setSchemaSearchPath(connection.asConnection()),
      ).toBe(true);
      expect(connection.queries).toHaveLength(0);
    });

    it('quotes one schema name', async () => {
      const connection = new FakeConnection();
      await makeClient().setSchemaSearchPath(connection.asConnection(), 'app');
      expect(connection.queries[0].sql).toBe('set search_path to "app"');
    });

    it('quotes every schema name of an array', async () => {
      const connection = new FakeConnection();
      await makeClient().setSchemaSearchPath(connection.asConnection(), [
        'app',
        'public',
      ]);
      expect(connection.queries[0].sql).toBe(
        'set search_path to "app","public"',
      );
    });

    it('escapes a quote inside a schema name', async () => {
      const connection = new FakeConnection();
      await makeClient().setSchemaSearchPath(
        connection.asConnection(),
        'we"ird',
      );
      expect(connection.queries[0].sql).toBe('set search_path to "we""ird"');
    });

    it('warns about a comma, which is not how several schemas are written', async () => {
      const client = makeClient();
      const warnings: string[] = [];
      client.logger.warn = (m: string) => warnings.push(m);
      await client.setSchemaSearchPath(
        new FakeConnection().asConnection(),
        'a,b',
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Detected comma in searchPath');
    });

    it('refuses a search path that is neither a string nor an array', async () => {
      await expect(
        makeClient().setSchemaSearchPath(
          new FakeConnection().asConnection(),
          42 as any,
        ),
      ).rejects.toThrow('Expected searchPath to be Array/String');
    });
  });

  describe('an external PostgreJS pool', () => {
    it('borrows a connection and hands it back', async () => {
      const client = makeClient();
      const pool = new FakePool();
      const wrapped = client.wrapNativePool(pool.asPool());
      const connection = await wrapped.acquire().promise;
      expect(pool.acquired).toHaveLength(1);
      expect(connection.__knexUid).toBeDefined();
      expect(wrapped.release(connection)).toBe(true);
      expect(pool.released).toHaveLength(1);
    });

    it('reads the server version from the first connection it borrows', async () => {
      const client = makeClient();
      const pool = new FakePool();
      await client.wrapNativePool(pool.asPool()).acquire().promise;
      expect(client.version).toBe('18.6');
    });

    it('leaves closing the pool to whoever owns it', async () => {
      const pool = new FakePool();
      await makeClient().wrapNativePool(pool.asPool()).destroy();
      expect(pool.closed).toBe(0);
    });
  });

  describe('streaming', () => {
    it('refuses an empty statement', () => {
      expect(() =>
        makeClient()._stream(
          new FakeConnection().asConnection(),
          { sql: '' },
          {} as any,
        ),
      ).toThrow('The query is empty');
    });
  });

  describe('warnings about the connection config', () => {
    it('says once per configuration that an option was ignored', () => {
      const client = new PostgrejsClient({
        client: PostgrejsClient,
        connection: { host: '127.0.0.1', statement_timeout: 1000 },
        pool: { max: 0 },
      } as any) as any;
      const warnings: string[] = [];
      client.logger.warn = (m: string) => warnings.push(m);
      client._connectionConfiguration();
      client._connectionConfiguration();
      expect(warnings).toHaveLength(1);
    });
  });
});
