# Migrating from `pg`

Everything Knex writes stays the same: your queries, migrations, seeds and any Objection models on
top of them. What changes is the driver underneath, and two things your code reads back from it.

## The switch

```ts
import knex from 'knex';
import { PostgrejsClient } from 'knex-postgrejs';

const db = knex({
  client: PostgrejsClient,          // was: client: 'pg'
  connection: 'postgres://localhost:5432/mydb',
});
```

Then uninstall `pg` and `pg-query-stream`. Nothing in this package imports either.

## Connection options

The familiar host, port, user, password, database and ssl settings work unchanged. Four spellings
differ and are translated for you:

| You may have written       | What it becomes    |
| -------------------------- | ------------------ |
| `application_name`         | `applicationName`  |
| `fallback_application_name`| `applicationName`  |
| `connectionTimeoutMillis`  | `connectTimeoutMs` |
| `port` as a string         | `port` as a number |

Six have no equivalent, and the client warns on the log rather than dropping them in silence:
`statement_timeout`, `query_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`,
`options` and `types`. The server-side timeouts belong in `pool.afterCreate`:

```ts
pool: {
  afterCreate(connection, done) {
    connection
      .query("set statement_timeout to '30s'")
      .then(() => done(null, connection), done);
  },
}
```

`types` was `pg`'s way of overriding a type parser. The equivalent here is `postgrejs.typeMap`,
which takes a PostgreJS `DataTypeMap`.

## Decoded values

This is the change worth reading. `pg` hands back a narrow set of JavaScript types, flattening
anything that does not fit a `number` into a string. PostgreJS keeps the value:

| Column        | `pg`                    | here                                       |
| ------------- | ----------------------- | ------------------------------------------ |
| `int8`        | `'15'`                  | `15`, or a `BigInt` past 2^53              |
| `numeric`     | `'12.34'`               | `12.34`, or a `Numeric` when precision asks |
| `money`       | `'$12.34'`              | `12.34`                                    |
| `int4range`   | `'[1,5)'`               | `Range`                                    |
| `point`       | `{ x, y }`              | `Point`                                    |
| `circle`      | `{ x, y, radius }`      | `Circle`                                   |
| `interval`    | `PostgresInterval`      | `Interval`                                 |

`date`, `timestamptz`, `bytea`, `json`, `jsonb`, the array types and everything else are unchanged.

If auditing every model is not where you want to start, ask for the narrower set instead:

```ts
knex({
  client: PostgrejsClient,
  connection: '...',
  postgrejs: { decoding: 'pg' },
});
```

That asks the server to render those columns as text, which is what `pg` reads. It is a way to
land the switch in one commit and deal with the types in the next, rather than somewhere to
settle: the text path costs a round of parsing, and it gives up the precision the default keeps.

`test/C-differential/values.spec.ts` runs that mode beside Knex's built-in client over 63 column
types and fails on any difference, so it can be relied on while it is needed. Two types stay
different even then - `point` and `circle` arrive as `Point` and `Circle`, `interval` as an
`Interval`. The fields are the same under the same names, and `JSON.stringify` gives the identical
string; the class also renders itself as `(1,2)` rather than `[object Object]`.

## Result objects

`knex.raw()` answers `command`, `rowCount`, `rows` and `fields`, as before, plus `commandTag` -
the whole command tag, where `pg` keeps only its first word (`CREATE INDEX` rather than `CREATE`).

`fields` carries the familiar `name`, `tableID`, `columnID`, `dataTypeID`, `dataTypeSize`,
`dataTypeModifier` and `format`, and adds PostgreJS's own `dataTypeName`, `jsType` and `isArray`.
One value differs: `format` reports `'binary'`, because that is what PostgreJS asks the server for.

`pg`'s two legacy fields, `oid` and `rowAsArray`, are not reproduced, and neither are its internal
parser tables.

`rowCount` is the command tag's count, as before: a number for the commands whose tag carries one,
`null` for the rest. `MOVE` and `COPY` are the exception - their count is the one thing PostgreJS
does not keep, so they report `null`. Neither reaches this path through Knex's own API.

## Errors

Identical, field for field: `code`, `severity`, `constraint`, `detail`, `table`, `column`,
`schema`, `hint`, `where`, and `position` as a string. `line`, `file` and `routine` mean
PostgreSQL's own C source location in `pg` and are not filled in here.

## Streaming

`.stream()` and `.pipe()` work as they always have, over a server-side cursor rather than
`pg-query-stream`. `batchSize`, `highWaterMark` and `rowMode: 'array'` all mean what they meant.
