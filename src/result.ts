import type { CommandResult, FieldInfo, Row } from 'postgrejs';

/**
 * One column of a result, named as `pg` names it.
 *
 * The first seven fields are `pg`'s own, so code written against
 * `result.fields[0].name` keeps working; the rest is what PostgreJS knows
 * on top of it and `pg` never had.
 */
export interface PostgrejsFieldInfo {
  /** The column's name, as the server described it. */
  name: string;
  /** OID of the table the column came from, 0 for a computed one. */
  tableID: number;
  /** The column's position in that table, 0 for a computed one. */
  columnID: number;
  /** OID of the column's type. */
  dataTypeID: number;
  /** The type's fixed width in bytes, -1 when it is variable. */
  dataTypeSize: number;
  /** The type's modifier - a `varchar(20)`'s 20 - or -1 when it has none. */
  dataTypeModifier: number;
  /**
   * The wire format the column arrived in.
   *
   * `'binary'` where `pg` always says `'text'`, because that is what each
   * client asks the server for. It is the one field of the seven whose
   * value differs, and it reports what happened rather than what `pg`
   * would have reported.
   */
  format: 'binary' | 'text';
  /** The type's name, such as `int4` or `timestamptz`. */
  dataTypeName: string;
  /** The JavaScript type PostgreJS decodes this column into. */
  jsType: string;
  /** Whether the column is an array. */
  isArray?: boolean;
  /** OID of the element type, when the column is an array. */
  elementDataTypeID?: number;
}

/**
 * What a query answers with, shaped as `pg`'s `QueryResult`.
 *
 * Knex hands this object straight back from `knex.raw()`, and reads
 * `command`, `rows` and `rowCount` off it to shape everything else, so
 * its job is to look exactly like what a `pg` user already reads.
 */
export interface PostgrejsQueryResult<R = any> {
  /**
   * The first word of the server's command tag, as `pg` reports it:
   * `SELECT`, `INSERT`, `CREATE`.
   */
  command: string;
  /**
   * The whole command tag, which `pg` throws away - `CREATE INDEX` rather
   * than `CREATE`, `DROP VIEW` rather than `DROP`.
   *
   * An addition of this client, so code that reads it does not port back
   * to `pg`.
   */
  commandTag: string;
  /**
   * The count from the command tag, as `pg` reports it: rows affected for
   * INSERT, UPDATE, DELETE and MERGE, rows returned for SELECT, and
   * `null` for a command that carries no count at all.
   */
  rowCount: number | null;
  /** The rows, empty rather than absent when a statement returns none. */
  rows: R[];
  /** What the columns were. */
  fields: PostgrejsFieldInfo[];
}

/**
 * The commands whose tag carries a row count, as the protocol defines
 * them. Every other command answers `rowCount: null` through `pg`.
 *
 * @see {@link https://www.postgresql.org/docs/current/protocol-message-formats.html}
 */
const COUNTED_COMMANDS = new Set([
  'INSERT',
  'DELETE',
  'UPDATE',
  'MERGE',
  'SELECT',
  'MOVE',
  'FETCH',
  'COPY',
]);

/** The first word of a command tag, which is all `pg` keeps. */
function firstWord(tag: string): string {
  const space = tag.indexOf(' ');
  return space === -1 ? tag : tag.slice(0, space);
}

/** One column description, from PostgreJS's names to `pg`'s. */
function toFieldInfo(
  field: FieldInfo,
  format: 'binary' | 'text',
): PostgrejsFieldInfo {
  return {
    name: field.fieldName,
    tableID: field.tableId ?? 0,
    columnID: field.columnId ?? 0,
    dataTypeID: field.dataTypeId,
    dataTypeSize: field.fixedSize ?? -1,
    dataTypeModifier: field.modifier ?? -1,
    format,
    dataTypeName: field.dataTypeName,
    jsType: field.jsType,
    isArray: field.isArray,
    elementDataTypeID: field.elementDataTypeId,
  };
}

/**
 * A PostgreJS result as `pg` would have reported it.
 *
 * @param result What PostgreJS answered with.
 * @param format The wire format the columns were asked for in.
 * @returns The result in `pg`'s shape.
 */
/* Two of the three conversions exist because PostgreJS leaves a field unset
   where there is nothing to report and `pg` says `[]` or `null` in the same
   place, and Knex's own `processResponse` reads both without checking.

   `rowCount` is deliberately not `rowsAffected` alone. PostgreJS sets that
   only for INSERT/UPDATE/DELETE/MERGE, on the grounds that what a SELECT
   reports is rows returned rather than rows affected - which is true, and is
   also not what `pg` does: `pg` reports whatever count the command tag
   carried, for whatever command it was, and `null` for a command whose tag
   carries none.

   So the count is rebuilt from the command rather than taken from the row
   array alone, which is not the same thing: `show transaction_isolation`
   and `explain select 1` both return a row and both answer `rowCount: null`
   through `pg`, because `SHOW` and `EXPLAIN` carry no count. For SELECT and
   FETCH the row array *is* the count - PostgreJS fetches every row by
   default - so the length stands in for it exactly.

   MOVE and COPY are where this stops being exact: their tags carry a count
   and return no rows, so `pg` reports a number here and this reports
   `null`. PostgreJS discards the count for every command but the four it
   calls affected, and there is nothing left to read it from - written up in
   `../postgrejs/.claude/command-tag-row-count.md`. Neither command reaches
   this path through Knex's own API. */
export function toQueryResult<R = Row>(
  result: CommandResult,
  format: 'binary' | 'text' = 'binary',
): PostgrejsQueryResult<R> {
  const tag = result.command ?? '';
  const command = firstWord(tag);
  const rows = (result.rows ?? []) as R[];
  return {
    command,
    commandTag: tag,
    rowCount:
      result.rowsAffected ??
      (COUNTED_COMMANDS.has(command) && result.rows ? rows.length : null),
    rows,
    fields: result.fields
      ? result.fields.map(field => toFieldInfo(field, format))
      : [],
  };
}
