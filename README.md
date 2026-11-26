# knex-postgrejs

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]

A [Knex](https://knexjs.org) client for [PostgreJS](https://github.com/panates/postgrejs). Pass it
where you would write `client: 'pg'` and everything above it stays the same - your queries, your
migrations, your seeds, and any Objection models on top.

Knex 3 does not depend on `pg` at all. Its PostgreSQL client is a class, and only about a dozen of
its methods talk to the driver; this package replaces those and leaves the rest alone. The SQL still
comes from Knex, so it keeps tracking Knex's own releases.

## Install

```sh
npm install knex-postgrejs knex postgrejs
```

`knex` (>=3.0.1 <4) and `postgrejs` (>=3.15 <4) are peer dependencies. Node >=22, and PostgreSQL 14 or
later - 16 and 18 are what CI runs.

You can uninstall `pg` and `pg-query-stream` afterwards. Nothing here imports either.

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

## Usage

### Connecting

`connection` takes what it always took: a connection string, an object of `pg`'s own options, or a
function returning either. The options both drivers spell the same way go straight through, and the
few that differ are translated:

| Knex / `pg`                 | PostgreJS           |
| --------------------------- | ------------------- |
| `application_name`          | `applicationName`   |
| `fallback_application_name` | `applicationName`   |
| `connectionTimeoutMillis`   | `connectTimeoutMs`  |
| `port` as a string          | `port` as a number  |

PostgreJS has settings `pg` has no name for, and they can be written in the same object: `schema`,
`timezone`, `keepAlive`, `hosts` and `targetSessionAttrs` for failover, `channelBinding`,
`preparedStatementCacheSize`, `asyncErrorHandling`.

```ts
const db = knex({
  client: PostgrejsClient,
  connection: {
    host: 'localhost',
    database: 'mydb',
    user: 'app',
    password: process.env.PGPASSWORD,
    // PostgreJS's own, in the same place
    hosts: [{ host: 'replica-1' }, { host: 'replica-2' }],
    targetSessionAttrs: 'read-write',
  },
  pool: { min: 2, max: 10 },
});
```

Five `pg` options have no PostgreJS equivalent, and the client says so on the log rather than
dropping them quietly: `statement_timeout`, `query_timeout`,
`idle_in_transaction_session_timeout`, `lock_timeout` and `options`. Set the server-side ones from
`pool.afterCreate`:

```ts
pool: {
  afterCreate(connection, done) {
    connection
      .query("set statement_timeout to '30s'")
      .then(() => done(null, connection), done);
  },
}
```

`types` is warned about too: `pg`'s type parsers do not apply here. Use `postgrejs.typeMap`, below.

### A pool your application already owns

Knex pools raw connections itself, with tarn, and that is the default here as it is with `pg`. If
you already have a PostgreJS `Pool` - because something else in the process uses it - hand it to
Knex instead:

```ts
import { Pool } from 'postgrejs';

const pool = new Pool('postgres://localhost:5432/mydb');
const db = knex({ client: PostgrejsClient, connectionPool: pool });
```

Knex borrows connections from it and never closes it; `db.destroy()` leaves the pool to you. This
needs Knex 3.3 or later, where `connectionPool` was added.

### Streaming

`.stream()` and `.pipe()` work as they always have, over a PostgreSQL cursor rather than
`pg-query-stream`:

```ts
for await (const row of db('events').stream({ batchSize: 500 })) {
  // 500 rows per round trip, and never more than that in memory
}
```

`batchSize` is how many rows one round trip fetches, `highWaterMark` how many the readable side
buffers, and `rowMode: 'array'` hands each row back as an array of values. Breaking out of the loop
closes the cursor and releases the connection.

### Cancelling a query

`.timeout(ms, { cancel: true })` cancels the running statement, as it does with `pg`:

```ts
await db('events').select('*').timeout(1000, { cancel: true });
```

PostgreSQL's cancel request travels on a connection of its own, which PostgreJS opens for exactly
this. Knex's `pg` client instead takes a second connection out of the pool to run
`pg_cancel_backend` on, so a timeout here costs one short-lived connection rather than two, and
never waits on a full pool.

### Options

Everything this client adds goes under one key:

```ts
const db = knex({
  client: PostgrejsClient,
  connection: '...',
  postgrejs: {
    decoding: 'pg',
    inferParameterTypes: true,
    normalizeErrors: true,
    prepare: undefined,
    rollbackOnError: false,
    typeMap: undefined,
    fetchAsString: [],
  },
});
```

#### `decoding`

`'pg'`, the default, returns what `pg` returns, type for type: `bigint` and `numeric` as strings,
`money` with the server's own formatting, ranges as strings. Existing code keeps working, and so do
Objection models written against it.

`'native'` is PostgreJS's own decoding, which is richer and is the reason to use PostgreJS at all - a
`BigInt` past 2^53, a `Numeric` that keeps every digit, typed geometric and `Range` classes. It
changes what your existing queries return, so it is opt-in. The table further down says exactly what
moves.

#### `inferParameterTypes`

On by default, and there is little reason to turn it off. PostgreJS gives each parameter a type OID
derived from its value; `pg` declares nothing and lets PostgreSQL resolve each parameter from where
its placeholder appears. The second is what every piece of Knex code was written against, so that is
what this client sends - see "Parameters take their type from where they appear" below.

#### `normalizeErrors`

On by default. PostgreJS adds a caret diagram to an error's `message`, pointing into the SQL, and
Knex then prepends the compiled statement to it - so a one-line `pg` message becomes three lines.
This puts the server's own text back and renders `position` as the string `pg` gives. Every
structured field (`code`, `constraint`, `detail`, `table`, ...) is identical either way.

#### `rollbackOnError`

Off by default, which is PostgreSQL's own behaviour and what Knex has always given: a failed
statement aborts the transaction, and nothing but a rollback is accepted after it. PostgreJS
defaults the other way, wrapping each statement in a savepoint of its own; `true` opts into that.

#### `prepare`

PostgreJS caches prepared statements per connection from the second use of the same SQL. `false` is
what PgBouncer in transaction pooling mode needs before 1.21, where a named statement does not
survive to the next call.

#### `typeMap` and `fetchAsString`

`typeMap` takes a PostgreJS `DataTypeMap`, for overriding how one type is decoded. `fetchAsString`
asks the server to render further OIDs as text, on top of whatever `decoding` already asks for.

### Reaching the client underneath

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

## Tested against Knex's own suite

`scripts/run-knex-suite.sh` checks Knex out at a known version, points its `postgres` variant at
this client and runs the whole thing, on Knex's own compose database. On Knex 3.3.0 it passes
**494 of 494, with 56 pending** - the same three numbers Knex's own `pg` client scores on the same
checkout, which is the comparison that matters.

The run leaves out the two sqlite dialect specs. They build a sqlite Knex while mocha is still
loading files, whatever `DB` is set to, so an unbuildable `better-sqlite3` fails nine tests that
have nothing to do with this client. They are another dialect's tests either way.

A weekly workflow runs the same thing against both ends of the peer range, to notice a change in
Knex rather than in this repository.

## What changes when you switch

Everything in this section is a test. `test/C-differential/` runs the same calls through Knex's own
`pg` client and through this one, on the same server, and fails on any difference that is not
listed here.

### Values

Under the default `decoding: 'pg'`, 58 of the 63 column types measured come back byte for byte as
`pg` returns them, including the ones that most often differ between drivers: `bigint` and `numeric`
as strings, `money` with its symbol and grouping, `date` and `timestamptz` as `Date`s, `bytea` as a
`Buffer`, ranges and multiranges as strings, arrays as arrays.

Five come back as a class where `pg` gives a plain object:

| Type                           | `pg`                            | here                                |
| ------------------------------ | ------------------------------- | ----------------------------------- |
| `point`, `point[]`             | `{ x, y }`                      | `Point { x, y }`                    |
| `circle`, `circle[]`           | `{ x, y, radius }`              | `Circle { x, y, radius }`           |
| `interval`, `interval[]`       | `PostgresInterval { years, ... }` | `Interval { years, ... }`             |

The fields are the same, under the same names, and `JSON.stringify` gives the identical string. What
the class adds is a `toString` that renders the value the way PostgreSQL writes it - `(1,2)` rather
than `[object Object]`.

Under `decoding: 'native'`, `bigint` becomes a `BigInt`, `numeric` a `Numeric` that keeps every
digit, `money` a number, and ranges `Range` objects.

### Parameters take their type from where they appear

PostgreJS derives a type OID for each parameter from its value, which is a declaration PostgreSQL
will not coerce. `pg` sends type 0 - unspecified - and lets the server work it out from the
placeholder's surroundings. This client does the same, for the values where it matters: numbers,
booleans, bigints, nulls, and plain objects, which go out as the JSON text `pg` would send.

Without that, ordinary Knex queries fail:

```ts
await db('users').where('reference', 42);        // operator does not exist: text = integer
await db('users').where('meta', { role: 'eng' }); // operator does not exist: jsonb = json
```

It costs what it costs `pg`: a parameter with neither a declared type nor any context resolves to
`text`.

```ts
await db.raw('select ? as v', [5]); // { v: '5' }, here and with pg
```

`postgrejs: { inferParameterTypes: false }` goes back to letting PostgreJS type each value, which
answers `5` for that query and breaks the two above.

### Results

`knex.raw()` hands back the result object, and this one carries what `pg`'s carries - `command`,
`rowCount`, `rows` and `fields` - plus `commandTag`, the whole command tag that `pg` throws away
(`CREATE INDEX` rather than `CREATE`). `pg`'s own parser tables and its two legacy fields (`oid`,
`rowAsArray`) are not reproduced.

`fields` is named as `pg` names it (`name`, `tableID`, `dataTypeID`, ...) and carries PostgreJS's own
information as well (`dataTypeName`, `jsType`, `isArray`). One value differs: `format` reports
`'binary'`, because that is what PostgreJS asks the server for, where `pg` always says `'text'`.

`rowCount` is the command tag's count, as it is in `pg` - a number for the commands whose tag
carries one, `null` for the rest. `MOVE` and `COPY` are the exception: their count is the one thing
PostgreJS does not keep, so they report `null` where `pg` reports a number. Neither reaches this
path through Knex's own API.

### Errors

Identical, field for field, including `code`, `severity`, `constraint`, `detail`, `table`, `column`
and `schema`, with `position` as a string. `line`, `file` and `routine` mean PostgreSQL's own C
source location in `pg` and are not filled in here.

## Objection

Objection depends on Knex alone, so there is nothing to configure:

```ts
import { Model } from 'objection';
import knex from 'knex';
import { PostgrejsClient } from 'knex-postgrejs';

Model.knex(knex({ client: PostgrejsClient, connection: '...' }));
```

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

The tests come in three kinds, and the split is deliberate:

- `test/A-common` - against the fakes in `test/_support/fakes.ts`, no server. Which options the
  client passes, in what order, and how it shapes what comes back.
- `test/B-live` - against a real server: streaming, cancellation asserted against
  `pg_stat_activity`, an external PostgreJS pool, the search path, the pool hooks.
- `test/C-differential` - the same calls through Knex's own `pg` client and through this one, on the
  same server, compared value for value. This is what the tables above are.

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
