/**
 * Makes a PostgreJS `DatabaseError` read the way `pg`'s does.
 *
 * @param error Whatever the query rejected with.
 * @returns The same object, with the two fields that differ put right.
 */
/* Every structured field is already identical - `code`, `severity`,
   `constraint`, `detail`, `table`, `column`, `schema`, `hint`, `where`,
   `dataType`, `internalQuery`, `internalPosition`. Knex branches on none of
   them, so this is entirely for the code above it, which for a Knex user is
   very often a `catch` that matches on `err.code` and logs `err.message`.

   Two differences are worth closing:

   - `message` carries a caret diagram pointing into the SQL. It is useful,
     and it is also what Knex prepends the compiled statement to before the
     caller ever sees it, so a one-line `pg` message becomes a three-line
     one. PostgreJS keeps the undecorated text on `serverMessage`, so this
     is a copy rather than a parse - there is no regex here and there must
     not be one.
   - `position` is a number where `pg` gives a string, which `pg` reads off
     the wire and never converts.

   `line`, `file` and `routine` are left alone. They mean PostgreSQL's own C
   source location in `pg`, and filling them in from anything else would be
   inventing values. */
export function normalizeError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const holder = error as {
    message?: string;
    serverMessage?: string;
    position?: unknown;
  };
  if (typeof holder.serverMessage === 'string')
    holder.message = holder.serverMessage;
  if (typeof holder.position === 'number')
    holder.position = String(holder.position);
  return error;
}
