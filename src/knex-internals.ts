/**
 * Knex's own PostgreSQL client, which this package's client extends.
 *
 * @see {@link https://github.com/knex/knex/blob/master/lib/dialects/postgres/index.js}
 */
/* Reached by path because Knex exports only the base `Client` from its
   package root, and the base carries none of the PostgreSQL SQL: the query
   compiler, the schema and table compilers, the view builders, the
   `$n` placeholder rewriting and the transaction class all live in
   `Client_PG`. Only the half that talks to `pg` is replaced here, so that
   SQL keeps coming from Knex and keeps tracking its releases.

   Knex's manifest has no `exports` map and its `files` list ships the whole
   of `lib/`, so the path is a supported entry rather than a hole in an
   encapsulation - and it is the same path Knex's own dialect index resolves.
   It carries no types, hence the cast: Knex types its base `Client` and
   `Client_PG` adds no member a subclass here reads. */
import type { Knex } from 'knex';
import ClientPgUntyped from 'knex/lib/dialects/postgres/index.js';

export const ClientPg = ClientPgUntyped as unknown as typeof Knex.Client;
