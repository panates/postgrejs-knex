import { DataTypeOIDs, type FetchAsStringItem } from 'postgrejs';

/**
 * The type OID `pg` declares for every parameter: unspecified, which
 * leaves PostgreSQL to resolve the type from where the placeholder
 * appears rather than from the value.
 *
 * @see {@link ./params.ts} for which values are bound this way.
 */
export const UNSPECIFIED_OID = 0;

/*
 * Range and multirange OIDs. `DataTypeOIDs` does not name them all, and
 * `pg` hands every range back as a string, so they are listed here to be
 * asked for as text.
 */
const RANGE_OIDS: number[] = [
  // int4range  numrange  tsrange  tstzrange  daterange  int8range
  3904, 3906, 3908, 3910, 3912, 3926,
  // and their array forms
  3905, 3907, 3909, 3911, 3913, 3927,
  // the multirange family, scalar then array
  4451, 4532, 4533, 4534, 4535, 4536, 6150, 6151,
];

/**
 * The OIDs `decoding: 'pg'` asks the server to render as text, because
 * `pg`'s own value for them is a string and PostgreJS decodes them into
 * something richer.
 *
 * Only that opt-in mode uses this list. The default decodes everything
 * natively and asks for nothing as text.
 *
 * @see {@link ../docs/MIGRATION-pg-to-postgrejs.md}, and
 * `test/C-differential/values.spec.ts`, which holds every entry to `pg`'s
 * own answer.
 */
/* The same list `typeorm-postgrejs` arrived at by measuring 64 scalar and
   array types, re-measured here against `pg` through Knex rather than
   copied on trust - `test/C-differential/values.spec.ts` runs every type on
   this list and a good many that are not, through both clients, and fails
   on any difference. Two entries look like omissions and are not:

   - `date`, `timestamp` and `timestamptz` are absent. `pg` parses those
     into `Date` objects and PostgreJS returns the identical `Date`, so
     asking for text would create a difference rather than remove one.
   - `interval` is absent for the same reason in the other direction:
     `pg` gives a plain object, PostgreJS an `Interval` carrying the same
     seven fields under the same names, and a bare string would be further
     from `pg` than the class is. */
export const FETCH_AS_STRING_OIDS: FetchAsStringItem[] = [
  DataTypeOIDs.int8,
  // `pg`'s array parser runs `parseFloat` per element even though a scalar
  // `numeric` stays a string. That is an inconsistency of `pg`'s rather
  // than a principle, and naming an OID on its own would reach the array
  // columns too, so the two are asked for separately.
  { oid: DataTypeOIDs.numeric, arrays: false },
  DataTypeOIDs.time,
  // `pg-types` registers no parser for `money`, so `pg` hands back the
  // server's own text - symbol, grouping and the scale `lc_monetary`
  // decides. PostgreJS decodes it to a number, which drops all three.
  DataTypeOIDs.money,
  DataTypeOIDs.line,
  DataTypeOIDs.lseg,
  DataTypeOIDs.box,
  DataTypeOIDs.path,
  DataTypeOIDs.polygon,
  // An array OID here means the whole literal arrives as one string rather
  // than as a JS array, so it belongs here only where `pg` also hands back
  // a string - which it does for these six, having no array parser for the
  // geometric family beyond `point[]`.
  DataTypeOIDs._line,
  DataTypeOIDs._lseg,
  DataTypeOIDs._box,
  DataTypeOIDs._path,
  DataTypeOIDs._polygon,
  DataTypeOIDs._circle,
  ...RANGE_OIDS,
];
