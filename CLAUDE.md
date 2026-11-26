# postgrejs-knex

A [Knex](https://knexjs.org) client for [PostgreJS](https://github.com/panates/postgrejs), so a Knex
query builder runs on PostgreJS's wire-protocol client instead of `pg`. The repository is
`postgrejs-knex`; the npm package is `knex-postgrejs`, the way round the other integrations are
named.

Objection depends on Knex alone, so this package covers it too - nothing Objection-specific belongs
here, and nothing in the public surface should assume Knex is the only thing above it.

## What Knex asks for

Knex 3 does not depend on `pg`: only `pg-connection-string` (for parsing a URL) and
`pg-query-stream` (a peer, for `.stream()`). Its PostgreSQL client is a class, `Client_PG` in
`lib/dialects/postgres/index.js`, and this package extends it - so the query compiler, the schema
and table compilers, the view builders, the `$n` placeholder rewriting and `Transaction_PG` stay
Knex's own, and keep tracking its releases. Only the methods that talk to the driver are replaced:

`_driver()`, `_acquireOnlyConnection()`, `destroyRawConnection()`, `validateConnection()`,
`checkVersion()`, `setSchemaSearchPath()`, `_query()`, `_stream()`, `cancelQuery()`,
`wrapNativePool()`.

`Client_PG` is reached by path (`knex/lib/dialects/postgres/index.js`), because Knex exports only
the base `Client` from its package root. Knex's manifest has no `exports` map and its `files` ships
all of `lib/`, so that is a supported entry rather than a hole in an encapsulation.

Four things about Knex that are not obvious and that each cost a debugging session:

- **`driverName` stays `'pg'`.** Knex uses it as the name of the SQL family, not of the npm package:
  `knex.fn.uuid()` switches on it and throws `does not have a uuid function` for a value it does not
  recognise. `_packageName` is the one that names this package's dependency, and it is only used in
  the "run npm install" message.
- **A transaction's client runs no constructor.** `makeTxClient` builds it with
  `Object.create(client.constructor.prototype)` and copies seven named fields - `config` among them,
  an instance field of ours not. Everything this client needs is therefore derived from `config`,
  lazily, rather than computed in a constructor. There is a unit test that builds a client the same
  way.
- **The builder's `stream()` forwards one argument.** `.stream(options, handler)` silently drops the
  handler and answers the stream itself; `.stream(handler)` answers a promise. That is Knex's own
  behaviour, identical on `pg`, and it is worth knowing before writing a test against it.
- **Knex mutates `connection.config`.** `acquireConnection` hides the password on it with
  `Object.defineProperty`, which throws on PostgreJS's frozen config. See "Settled decisions".

`processResponse` is inherited: it reads `command`, `rows` and `rowCount` off whatever `_query` put
on the query object, so the result has to be `pg`-shaped rather than PostgreJS-shaped.

## What PostgreJS gives you

Source of truth is the repository at `../postgrejs` (its own `CLAUDE.md` describes the internals).
The facts below were measured against a live server on PostgreJS 3.15, not recalled.

**`connection.query(sql, options)` returns every row.** `fetchCount` defaults to 0, the protocol's
"no limit", and a truncated result carries `suspended: true`. Rows are arrays unless
`rowDecoder: 'object'` is passed, which is what Knex reads.

**A result carries `command` (the whole tag), `fields`, `rows` and `rowsAffected`.** `rowsAffected`
is set for INSERT/UPDATE/DELETE/MERGE only, so `rowCount` is rebuilt in `src/result.ts` from the
command - see the note there, and `../postgrejs/.claude/command-tag-row-count.md` for the part that
cannot be rebuilt.

**Parameters are `$1`-style**, passed as `options.params`, so Knex's compiled SQL needs no
rewriting - but their types matter. PostgreJS sends strings, dates and arrays of numbers or strings
untyped already (`isUnspecifiedParam`); numbers, booleans, bigints, nulls and plain objects it
declares a type for, and a declared type is one PostgreSQL will not coerce. `src/params.ts` binds
those five at OID 0, which is what `pg` sends.

**Streaming is a cursor.** `query(sql, { cursor: true })` puts a `Cursor` on `result.cursor`, with
`next()`, `fetch(n)`, `close()` and `Symbol.asyncIterator`. `fetchCount` is the batch size.

**Errors** are `DatabaseError` with a PostgreSQL `code`, the undecorated text on `serverMessage` and
a numeric `position`.

**Pool.** `pool.acquire()` / `pool.release(connection)`. Knex pools raw connections itself with
tarn, so a PostgreJS `Pool` is only involved when the application passes one as `connectionPool`.

## Settled decisions

Chosen deliberately, and not worth re-opening without new evidence:

- **`decoding: 'pg'` is the default.** Knex is a drop-in context: existing queries and Objection
  models were written against `pg`'s values. `'native'` is the opt-in. The `fetchAsString` list in
  `src/constants.ts` is what makes `'pg'` work, and every entry on it is covered by
  `test/C-differential/values.spec.ts` - 58 of 63 types identical, 5 the same fields in a class.
- **Parameter types are left to the server** for numbers, booleans, bigints, nulls and plain
  objects; `inferParameterTypes: false` opts out. Measured, not reasoned: without it,
  `where('txt', 42)` and `where('jb', { a: 1 })` both fail.
- **`rollbackOnError: false` on every query** - PostgreSQL's semantics, not PostgreJS's.
- **`driverName` stays `'pg'`** (see above).
- **The password is pre-hidden on each connection.** Knex hides it with
  `Object.defineProperty(connection.config, 'password', { enumerable: false, value })`, and
  PostgreJS freezes `config`, so that call throws `Cannot redefine property: password` and no query
  runs. `hidePassword` in `src/client.ts` shadows `config` with a plain copy whose password is
  already a non-configurable, non-writable, non-enumerable property of the same value - redefining a
  property to the descriptor it already has is allowed, so Knex's own call then succeeds and changes
  nothing. It runs on connections this client opens and on connections borrowed from an external
  pool; the live test covers both.
- **`toConnectionConfiguration` reads every own key, not every enumerable one.** Knex has already
  made `password` non-enumerable by the time the settings reach a client, so `Object.keys` leaves it
  out and the connection goes out without one - silently, against a server that trusts local
  connections.
- **`cancelQuery` uses PostgreJS's out-of-band `cancel()`**, which opens its own short-lived
  connection, rather than taking a second one out of the pool as Knex's `pg` client does.
- **`checkVersion` reads `sessionParameters.server_version`** rather than running `select
  version()`, saving a round trip per pool.
- **Peer range is `knex >=3.0.1 <4`.** The client surface this package overrides is identical
  across 3.0 to 3.3. The floor is 3.0.1 rather than 3.0.0 because 3.0.0's npm tarball is missing
  `lib/dialects/index.js`, so `require('knex')` throws before any client is involved - knex's own
  packaging, reproducible with nothing but `npm i knex@3.0.0 && node -e "require('knex')"`.
  `connectionPool`/`wrapNativePool` is the one addition in the range, in 3.3, and it is simply
  never called on an older version; the two live tests for it skip themselves when
  `initializeExternalPool` is absent.

## Layout and tests

`src/` is eight files: the client, its options, the parameter and result conversions, the error
normalisation, the connection-settings translation, the cursor stream, and the Knex import.

- `test/A-common/` - unit tests against the fakes in `test/_support/fakes.ts`. Which options the
  client passes, in what order, and how it shapes what comes back, with no server deciding any of
  it.
- `test/B-live/` - against a live PostgreSQL: streaming, cancellation asserted against
  `pg_stat_activity`, an external PostgreJS pool, the search path, the pool hooks, the password.
- `test/C-differential/` - the same calls through Knex's own `pg` client and through this one, on
  the same server, compared value for value. The README's tables are this directory. The harness
  rebuilds the schema between the two runs, so both start from the same state - a comparison that
  runs both drivers against shared state measures the order they ran in.
- Code style follows the PostgreJS repository's own `CLAUDE.md`: member order, `protected` over
  `private`, TSDoc for the contract and a plain block comment underneath for the reasoning.
- Lint, format, check, clean and build are rman commands from `@panates/rman-preset`, not package
  scripts. `rman lint --fix` sorts imports.
- Coverage is 100% of statements, lines and functions. c8 reports one uncovered branch, on
  `checkVersion`'s `select version()` fallback: the path taken by a server that sends no
  `server_version` parameter, which no PostgreSQL does. Don't chase it, and don't delete the
  fallback to make the number round.

## Knex's own suite

`scripts/run-knex-suite.sh` runs Knex's own test suite against this client: it checks Knex out,
points its `postgres` variant at us (`scripts/knex-suite.patch`), and uses Knex's own compose
database on port 25432, so a local server is untouched.

Two things the script had to learn:

- **The install cannot skip scripts.** Knex's suite loads its sqlite specs whatever `DB` is set to,
  and an unbuilt `sqlite3` takes the run down before a single postgres test starts.
- **mocha can exit 0 having run nothing.** The script fails when the log reports no passing count at
  all, because a run that fell over on load otherwise reads as a pass.

## Build and release

Single-package: the repository *is* the package. `.rmanrc.yml` inherits `@panates/rman-preset`.

- `private: true` stays in the source manifest and rman drops it in the build directory. Check with
  `rman publish --dry-run`: it must show a `publish` row, never `skip - private package`.
- `CHANGELOG.md` is rman's. `rman version` writes the entry into the release commit.

## Working conventions

- **No fixups here. A gap in PostgreJS is reported, not worked around.** When something this client
  needs is missing, wrong or slower in `postgrejs`, do not patch around it: no post-decode value
  rewriting, no shim, no vendored parser, no monkey-patching of the client. Write the finding up as
  a task file in `../postgrejs/.claude/<short-name>.md` - what was asked of the client, what it
  answered, what it should answer, and the smallest reproduction that shows the difference. That
  repository's own session fixes it at the source. A workaround is allowed only when the user is
  asked for one and says yes; it then carries a comment naming the task file it waits on.
  `command-tag-row-count.md` is the one open finding.
- Adapting to Knex is not a fixup. `hidePassword` and the connection-settings translation are this
  package's job: Knex mutates what it is handed and spells its options `pg`'s way, and neither is
  something PostgreJS should change.
- Do not sign commits or pull requests on the assistant's behalf.
- Run `git status` before staging. Commit only the files the change is about.
- Every change comes with a test.
- Claims about how another library behaves get checked against that library's own source, not its
  documentation. Every table in the README is a differential test for the same reason.
- Do not publish a performance number that was not measured. There is no benchmark in this
  repository yet, and the README makes no speed claim until there is.

## Local setup

PostgreSQL runs on `127.0.0.1:5432` (`postgres`/`postgres`, database `postgres`) from the docker
compose in the PostgreJS repository - that is what `pnpm test`'s live and differential tests use.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
