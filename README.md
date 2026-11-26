# knex-postgrejs

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

A [Knex](https://knexjs.org) client for [PostgreJS](https://github.com/panates/postgrejs), the
from-scratch PostgreSQL wire-protocol driver for Node.js. Your queries, migrations and seeds stay
exactly as they are; what runs underneath them changes.

Knex 3 brings no PostgreSQL driver of its own, and its client is a class. This package subclasses
Knex's PostgreSQL client and replaces the dozen methods that open connections, run statements and
stream rows. Everything that writes SQL - the query compiler, the schema and table compilers, the
transaction handling - stays Knex's own, so this client speaks whatever dialect your installed Knex
speaks.

## Install

```sh
npm install knex-postgrejs knex postgrejs
```

`knex` (>=3.0.1 <4) and `postgrejs` (>=3.15 <4) are peer dependencies. Node >=22, and PostgreSQL 14
or later - 16 and 18 are what CI runs.

No native bindings, no `libpq`, nothing to compile.

## Quick start

```ts
import knex from 'knex';
import { PostgrejsClient } from 'knex-postgrejs';

const db = knex({
  client: PostgrejsClient,
  connection: 'postgres://localhost:5432/mydb',
});

await db('users').where('active', true).select('id', 'name');
```

That is the whole change.

## Values

Rows come back decoded by PostgreJS, which keeps the value the column holds rather than flattening
it to a string you have to parse back:

```ts
const [row] = await db('orders').select('total', 'reference', 'placed_during');

row.total;          // 12.34
row.reference;      // 9007199254740993n
row.placed_during;  // Range, with its lower and upper bounds
```

`numeric` and `int8` follow one rule: a plain number while that is lossless, and a type that keeps
every digit when it is not. A `numeric` of `12.34` is `12.34`; one of
`123456789012345678901234567890.123456789` is a `Numeric` that has not dropped a digit. An `int8`
inside the safe integer range is a number, so `count()` is arithmetic-ready, and one beyond it is a
`BigInt` rather than a rounded approximation.

`point`, `circle` and `interval` arrive as classes that know how to print themselves, `date` and
`timestamptz` as `Date`, `bytea` as a `Buffer`, `json` and `jsonb` parsed.

`postgrejs.typeMap` takes a PostgreJS `DataTypeMap` if you want to change how one type is decoded,
and `postgrejs.fetchAsString` asks the server to render particular OIDs as text.

## Usage

### Connecting

`connection` takes a connection string, an object, or a function returning either. The usual host,
port, user, password, database and ssl settings work as they always have, and PostgreJS's own
settings go in the same object:

```ts
const db = knex({
  client: PostgrejsClient,
  connection: {
    host: 'localhost',
    database: 'mydb',
    user: 'app',
    password: process.env.PGPASSWORD,
    hosts: [{ host: 'replica-1' }, { host: 'replica-2' }],
    targetSessionAttrs: 'read-write',
    channelBinding: 'require',
  },
  pool: { min: 2, max: 10 },
});
```

`hosts` and `targetSessionAttrs` are how a connection finds the current primary after a failover.
`schema`, `timezone`, `keepAlive`, `preparedStatementCacheSize` and `asyncErrorHandling` are
available in the same place.

A few options from the `pg` world have no equivalent here, and the client warns on the log rather
than dropping them in silence: `statement_timeout`, `query_timeout`,
`idle_in_transaction_session_timeout`, `lock_timeout`, `options` and `types`. The server-side
timeouts belong in `pool.afterCreate`:

```ts
pool: {
  afterCreate(connection, done) {
    connection
      .query("set statement_timeout to '30s'")
      .then(() => done(null, connection), done);
  },
}
```

### A pool your application already owns

Knex pools connections itself, with tarn, and that is the default. If a PostgreJS `Pool` already
exists in the process, hand Knex that instead:

```ts
import { Pool } from 'postgrejs';

const pool = new Pool('postgres://localhost:5432/mydb');
const db = knex({ client: PostgrejsClient, connectionPool: pool });
```

Knex borrows connections from it and never closes it; `db.destroy()` leaves the pool to you. Needs
Knex 3.3 or later, where `connectionPool` was added.

### Streaming

`.stream()` and `.pipe()` run over a server-side cursor:

```ts
for await (const row of db('events').stream({ batchSize: 500 })) {
  // 500 rows per round trip, and never more than that in memory
}
```

`batchSize` is how many rows one round trip fetches, `highWaterMark` how many the readable side
buffers, and `rowMode: 'array'` hands each row back as an array of values. Breaking out of the loop
closes the cursor and releases the connection.

### Cancelling a query

```ts
await db('events').select('*').timeout(1000, { cancel: true });
```

PostgreSQL's cancel request travels on a connection of its own, which PostgreJS opens for exactly
this, so a timeout costs one short-lived connection and never waits on a full pool.

### Reaching the driver underneath

The connection Knex hands you is a PostgreJS `Connection`, so everything Knex has no way to ask for
is reachable through it - COPY, LISTEN/NOTIFY, large objects, logical replication:

```ts
const connection = await db.client.acquireConnection();
try {
  await connection.listen('order_placed', msg => console.log(msg.payload));
} finally {
  await db.client.releaseConnection(connection);
}
```

### Options

Everything this client adds goes under one key:

```ts
knex({
  client: PostgrejsClient,
  connection: '...',
  postgrejs: {
    decoding: 'native',
    inferParameterTypes: true,
    normalizeErrors: true,
    rollbackOnError: false,
    prepare: undefined,
    typeMap: undefined,
    fetchAsString: [],
  },
});
```

| Option                | Default    | What it does                                                        |
| --------------------- | ---------- | ------------------------------------------------------------------- |
| `decoding`            | `'native'` | `'pg'` narrows the decoded types - see "Moving from pg"              |
| `inferParameterTypes` | `true`     | Leaves each parameter's type to the server to resolve from context   |
| `normalizeErrors`     | `true`     | Strips the caret diagram from an error's `message`                   |
| `rollbackOnError`     | `false`    | PostgreSQL's own rule: a failed statement aborts the transaction     |
| `prepare`             | unset      | `false` turns off the per-connection prepared statement cache        |
| `typeMap`             | unset      | A `DataTypeMap`, to change how one type is decoded                   |
| `fetchAsString`       | unset      | Further OIDs to have the server render as text                       |

Two are worth a sentence beyond the table.

**`inferParameterTypes`** leaves each parameter untyped on the wire, so PostgreSQL resolves it from
where the placeholder appears. That is what makes `where('meta', { role: 'eng' })` match a `jsonb`
column and `where('reference', 42)` match a `text` one. Turning it off hands every value to
PostgreJS to type from the value itself, which is stricter than most Knex code expects. The cost of
leaving it on is that a parameter with no context at all resolves to `text`: `db.raw('select ?',
[5])` answers `'5'`.

**`rollbackOnError`** defaults to PostgreSQL's own behaviour - a failed statement aborts the
transaction and only a rollback is accepted after it. PostgreJS defaults the other way, wrapping
each statement in a savepoint of its own; `true` opts into that.

## Moving from pg

Replace `client: 'pg'` with `client: PostgrejsClient` and uninstall `pg` and `pg-query-stream`;
nothing here imports either. A handful of connection options are spelled differently and are
translated for you: `application_name` and `fallback_application_name` become `applicationName`,
`connectionTimeoutMillis` becomes `connectTimeoutMs`, and a port that arrives as a string is read
as a number.

What your code reads changes in two places.

**Decoded types.** `bigint`, `numeric`, `money` and the range types reach you as JavaScript types
rather than strings. If that means auditing every model, `decoding: 'pg'` asks the server to render
those columns as text instead, which gives the narrower set `pg` hands back:

```ts
postgrejs: { decoding: 'pg' }
```

It is a migration aid rather than somewhere to settle: that path pays for a round of text parsing
and gives up the precision the default keeps. `test/C-differential/values.spec.ts` holds it to
`pg`'s answer across 63 column types, so it can be relied on while it is needed.

Two types stay different even then. `point` and `circle` arrive as `Point` and `Circle`, `interval`
as an `Interval` - the same fields under the same names, and the same `JSON.stringify` output, in a
class that also renders itself as `(1,2)` rather than `[object Object]`.

**Result objects.** `knex.raw()` answers `command`, `rowCount`, `rows` and `fields`, plus
`commandTag`, the full command tag (`CREATE INDEX` rather than `CREATE`). `fields` carries the
familiar `name`, `tableID` and `dataTypeID` along with PostgreJS's `dataTypeName`, `jsType` and
`isArray`. Errors are unchanged, field for field, down to `code`, `constraint`, `detail`, `table`
and `column`.

## Objection

Objection depends on Knex alone, so there is nothing else to configure:

```ts
import { Model } from 'objection';
import knex from 'knex';
import { PostgrejsClient } from 'knex-postgrejs';

Model.knex(knex({ client: PostgrejsClient, connection: '...' }));
```

## Tested against Knex's own suite

`scripts/run-knex-suite.sh` checks Knex out at a known version, points its `postgres` variant at
this client and runs the whole thing on Knex's own database. On Knex 3.3.0 it passes **494 of 494,
with 56 pending** - the same three numbers Knex's own client scores on the same checkout, which is
the comparison that matters.

The suite runs in `decoding: 'pg'`, because its assertions spell out `pg`'s own JavaScript types
(`sum: '15'`, `id: '2'`). What it is there to check is the SQL and the behaviour; which type a
`bigint` decodes to is this package's own question, and its own tests answer it.

The run leaves out the two sqlite dialect specs. They build a sqlite Knex while mocha is still
loading files, whatever `DB` is set to, so an unbuildable `better-sqlite3` fails nine tests that
have nothing to do with this client.

A weekly workflow runs the same thing, to notice a change in Knex rather than in this repository.

## Development

```sh
pnpm install
pnpm test                   # unit, live and differential tests
pnpm run typecheck
rman lint                   # lint, format and check are rman commands
rman check
rman build
scripts/run-knex-suite.sh   # Knex's own suite, on its own database
```

The tests come in three kinds:

- `test/A-common` - against the fakes in `test/_support/fakes.ts`, no server. Which options the
  client passes, in what order, and how it shapes what comes back.
- `test/B-live` - against a real server: decoding, streaming, cancellation asserted against
  `pg_stat_activity`, an external PostgreJS pool, the search path, the pool hooks.
- `test/C-differential` - the `decoding: 'pg'` mode run beside Knex's own client on the same
  server, compared value for value.

The live tests need a PostgreSQL on `127.0.0.1:5432` (`postgres`/`postgres`, database `postgres`);
the docker compose in the PostgreJS repository is one.

## License

BSD-3-Clause

[npm-image]: https://img.shields.io/npm/v/knex-postgrejs
[npm-url]: https://npmjs.org/package/knex-postgrejs
[downloads-image]: https://img.shields.io/npm/dm/knex-postgrejs.svg
[downloads-url]: https://npmjs.org/package/knex-postgrejs
[ci-test-image]: https://github.com/panates/postgrejs-knex/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/postgrejs-knex/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/postgrejs-knex/dev.svg
[coveralls-url]: https://coveralls.io/r/panates/postgrejs-knex
