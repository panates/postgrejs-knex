import { EventEmitter } from 'node:events';
import type { Connection, Pool, QueryOptions, QueryResult } from 'postgrejs';
import { ConnectionState } from 'postgrejs';

/**
 * Stand-ins for PostgreJS's `Connection` and `Pool`, so the client's own
 * call sequence can be asserted exactly - which options it passes, in
 * which order, and how many times - without a live server deciding any of
 * it.
 */

export interface RecordedCall {
  method: string;
  args: any[];
}

/** A promise something else decides the timing of. */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

export class FakeCursor {
  closed = false;
  readonly served: any[] = [];
  protected _rows: any[];

  constructor(rows: any[]) {
    this._rows = rows.slice();
  }

  async next(): Promise<any> {
    const row = this._rows.shift();
    this.served.push(row);
    return row;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeConnection extends EventEmitter {
  readonly calls: RecordedCall[] = [];
  state: ConnectionState = ConnectionState.READY;
  sessionParameters: Record<string, string> = { server_version: '18.6' };
  config = { host: 'fake-host', database: 'fake-db' };
  processID?: number;
  /** When set, `query()` waits for this before answering. */
  queryGate?: Promise<void>;
  /** What `query()` answers - or throws, when it is an Error. */
  queryResult:
    | QueryResult
    | Error
    | ((sql: string, options?: QueryOptions) => QueryResult | Error) = {
    command: 'SELECT',
    rows: [],
  };

  constructor(processID?: number) {
    super();
    this.processID = processID;
  }

  get queries(): { sql: string; options?: QueryOptions }[] {
    return this.calls
      .filter(call => call.method === 'query')
      .map(call => ({ sql: call.args[0], options: call.args[1] }));
  }

  async connect(): Promise<void> {
    this.calls.push({ method: 'connect', args: [] });
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] });
    this.state = ConnectionState.CLOSED;
  }

  async cancel(): Promise<void> {
    this.calls.push({ method: 'cancel', args: [] });
  }

  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    this.calls.push({ method: 'query', args: [sql, options] });
    if (this.queryGate) await this.queryGate;
    const result =
      typeof this.queryResult === 'function'
        ? this.queryResult(sql, options)
        : this.queryResult;
    if (result instanceof Error) throw result;
    return result;
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

export class FakePool extends EventEmitter {
  readonly acquired: FakeConnection[] = [];
  readonly released: FakeConnection[] = [];
  closed = 0;
  protected _nextProcessId = 1000;

  async acquire(): Promise<Connection> {
    const connection = new FakeConnection(this._nextProcessId++);
    this.acquired.push(connection);
    return connection.asConnection();
  }

  async release(connection: Connection): Promise<void> {
    this.released.push(connection as unknown as FakeConnection);
  }

  async close(): Promise<void> {
    this.closed++;
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}
