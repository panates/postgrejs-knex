import { BindParam } from 'postgrejs';
import { UNSPECIFIED_OID } from './constants.js';

/**
 * A value that renders itself for PostgreSQL, `pg`'s own convention.
 *
 * Knex honours it when it escapes a binding into an error message, so a
 * parameter that carries one is rendered the same way on both paths.
 */
export interface ToPostgres {
  toPostgres(prepareValue: (value: unknown) => unknown): unknown;
}

/**
 * Whether a value is a plain object rather than one of the object types
 * PostgreJS has an encoder for.
 */
function isPlainObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !ArrayBuffer.isView(value) &&
    !Buffer.isBuffer(value)
  );
}

/**
 * One binding as `pg` would hand it to the server.
 *
 * @param value The binding Knex compiled.
 * @returns The value, or a {@link BindParam} declaring no type for it.
 */
/* PostgreJS derives a type OID from the value it is given, and a declared
   type is one PostgreSQL will not coerce. `pg` declares nothing and lets the
   server resolve each parameter from where its placeholder appears, which is
   what every piece of Knex code in existence was written against.

   Which values need saying so for was measured against a live server rather
   than reasoned about - `.probe` runs in the pull request, and
   `test/C-differential/params.spec.ts` keeps the result - and it is a
   shorter list than it looks, because PostgreJS already sends strings,
   dates and arrays of numbers or strings untyped for the same reasons `pg`
   does. What is left:

   - A **number** is declared `int4` or `float8`, so `where txt = ?` with a
     number fails with `operator does not exist: text = integer`, and
     `coalesce(?, txt)` with `COALESCE types integer and text cannot be
     matched`. Both work through `pg`.
   - A **boolean**, a **bigint** and **null** are declared for the same
     reason, and are wrapped with the numbers rather than waiting for a
     query shape that proves each one separately.
   - A **plain object** is declared `json`, which an INSERT into a `jsonb`
     column survives on an assignment cast but a comparison does not:
     `where jb = ?` fails with `operator does not exist: jsonb = json`.
     `pg` sends the JSON text untyped, so that is what goes out here.

   The cost is the one `pg` already pays: a parameter with no type and no
   context resolves to `text`, so `select ?` with a 5 answers `'5'` rather
   than 5. There is a differential test pinning both sides of that. */
export function toBindParam(value: unknown): unknown {
  if (value === null || value === undefined)
    return new BindParam(UNSPECIFIED_OID, value);
  const type = typeof value;
  if (type === 'number' || type === 'boolean' || type === 'bigint')
    return new BindParam(UNSPECIFIED_OID, value);
  if (isPlainObject(value)) {
    const candidate = value as Partial<ToPostgres>;
    const rendered =
      typeof candidate.toPostgres === 'function'
        ? // `pg` recurses through `prepareValue` here; the identity function
          // stands in for it because whatever comes back is bound untyped
          // either way, and a `toPostgres` returning another object is a
          // shape `pg` itself only resolves by recursing to a scalar.
          String(candidate.toPostgres(inner => inner))
        : JSON.stringify(value);
    return new BindParam(UNSPECIFIED_OID, rendered);
  }
  return value;
}

/**
 * The bindings of one statement, as `pg` would hand them to the server.
 *
 * @param bindings What Knex compiled, which may be absent.
 * @param inferParameterTypes Whether to leave each type to the server.
 * @returns Parameters for PostgreJS, or `undefined` when there are none.
 */
export function toBindParams(
  bindings: readonly unknown[] | undefined,
  inferParameterTypes: boolean,
): unknown[] | undefined {
  if (!bindings || !bindings.length) return undefined;
  const l = bindings.length;
  const params = new Array(l);
  let i: number;
  if (!inferParameterTypes) {
    for (i = 0; i < l; i++) params[i] = bindings[i];
    return params;
  }
  for (i = 0; i < l; i++) params[i] = toBindParam(bindings[i]);
  return params;
}
