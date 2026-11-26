import { expect } from 'expect';
import {
  comparable,
  type Differential,
  openDifferential,
} from '../_support/differential.js';

/**
 * Every column type, read back through Knex's own `pg` client and through
 * this one, and compared value for value.
 *
 * This is what the README's "What changes when you switch" table is: a
 * type that moves between the two lists fails a test here rather than
 * going unnoticed until someone reads a row.
 */
describe('differential: values', function () {
  this.timeout(120000);
  let d: Differential;

  before(async () => {
    d = await openDifferential('diff_values');
  });
  after(async () => {
    await d?.close();
  });

  /** `select <literal>::<type>`, through both clients. */
  async function readBack(type: string, literal: string) {
    return d.readOnly(async db => {
      const result = await db.raw(`select ${literal}::${type} as v`);
      return comparable(result.rows[0].v);
    });
  }

  /**
   * Types both clients answer identically - which is all but five of
   * them, and every one that an application is likely to store.
   */
  const IDENTICAL: [string, string][] = [
    ['int2', '1'],
    ['int4', '1'],
    ['int8', '9007199254740993'],
    ['numeric', '12.3456789'],
    ['float4', '1.5'],
    ['float8', '1.5'],
    ['money', '12.34'],
    ['bool', 'true'],
    ['text', "'hi'"],
    ['varchar(10)', "'hi'"],
    ['char(3)', "'hi'"],
    ['name', "'hi'"],
    ['bytea', "'\\x6869'"],
    ['uuid', "'0d9bbb4e-1c1f-4d2e-9b1a-1f0c0a0b0c0d'"],
    ['json', '\'{"a":1}\''],
    ['jsonb', '\'{"a":1}\''],
    ['xml', "'<a/>'"],
    ['date', "'2024-03-05'"],
    ['time', "'12:30:00'"],
    ['timetz', "'12:30:00+03'"],
    ['timestamp', "'2024-03-05 12:30:00'"],
    ['timestamptz', "'2024-03-05 12:30:00+03'"],
    ['line', "'{1,2,3}'"],
    ['lseg', "'[(1,2),(3,4)]'"],
    ['box', "'((1,2),(3,4))'"],
    ['path', "'[(1,2),(3,4)]'"],
    ['polygon', "'((1,2),(3,4))'"],
    ['cidr', "'192.168.0.0/24'"],
    ['inet', "'192.168.0.1'"],
    ['macaddr', "'08:00:2b:01:02:03'"],
    ['bit(3)', "B'101'"],
    ['varbit(3)', "B'101'"],
    ['int4range', "'[1,5)'"],
    ['numrange', "'[1.5,5.5)'"],
    ['tsrange', "'[2024-01-01,2024-02-01)'"],
    ['daterange', "'[2024-01-01,2024-02-01)'"],
    ['int8range', "'[1,5)'"],
    ['int4multirange', "'{[1,5)}'"],
    ['oid', '42'],
    ['tsvector', "'a b'"],
    ['tsquery', "'a & b'"],
    ['int2[]', "'{1,2}'"],
    ['int4[]', "'{1,2}'"],
    ['int8[]', "'{1,2}'"],
    ['numeric[]', "'{1.5,2.5}'"],
    ['float8[]', "'{1.5}'"],
    ['bool[]', "'{true,false}'"],
    ['text[]', "'{a,b}'"],
    ['date[]', "'{2024-03-05}'"],
    ['timestamptz[]', '\'{"2024-03-05 12:30:00+03"}\''],
    ['json[]', '\'{"{\\"a\\":1}"}\''],
    ['jsonb[]', '\'{"{\\"a\\":1}"}\''],
    ['uuid[]', "'{0d9bbb4e-1c1f-4d2e-9b1a-1f0c0a0b0c0d}'"],
    ['bytea[]', '\'{"\\\\x6869"}\''],
    ['money[]', "'{12.34}'"],
    ['inet[]', "'{192.168.0.1}'"],
    ['circle[]', '\'{"<(1,2),3>"}\''],
    ['int4range[]', '\'{"[1,5)"}\''],
  ];

  for (const [type, literal] of IDENTICAL)
    it(`${type} reads back exactly as pg reads it`, async () => {
      const { pg, pgjs } = await readBack(type, literal);
      expect(pgjs).toEqual(pg);
    });

  /**
   * The five types whose answers differ, and the one way in which they
   * do: `pg` hands back a plain object (or `postgres-interval`'s class),
   * PostgreJS a class of its own carrying the same fields under the same
   * names. Everything an application reads off them - the keys, the
   * values, `JSON.stringify` - is identical; what PostgreJS adds is a
   * `toString` that renders the value the way PostgreSQL writes it.
   */
  const SAME_FIELDS: [string, string, string][] = [
    ['point', "'(1,2)'", 'Point'],
    ['circle', "'<(1,2),3>'", 'Circle'],
    ['interval', "'1 year 2 months 3 days 4 hours'", 'Interval'],
    ['point[]', '\'{"(1,2)"}\'', 'Point'],
    ['interval[]', '\'{"1 day"}\'', 'Interval'],
  ];

  for (const [type, literal, className] of SAME_FIELDS) {
    it(`${type} carries the same fields as pg's answer`, async () => {
      const { pg, pgjs } = await d.readOnly(async db => {
        const result = await db.raw(`select ${literal}::${type} as v`);
        return JSON.stringify(result.rows[0].v);
      });
      expect(pgjs).toBe(pg);
    });

    it(`${type} is a ${className}, which pg has no class for`, async () => {
      const { pg, pgjs } = await readBack(type, literal);
      expect(pgjs).not.toEqual(pg);
      const first = (value: any) => (Array.isArray(value) ? value[0] : value);
      expect(first(pgjs).class).toBe(className);
    });
  }

  it('reads int8 as a string, as pg does, under the default decoding', async () => {
    const { pg, pgjs } = await d.readOnly(async db => {
      const result = await db.raw('select count(*) as c from pg_class');
      return typeof result.rows[0].c;
    });
    expect(pg).toBe('string');
    expect(pgjs).toBe('string');
  });

  it('reads int8 natively when asked to, which is the point of PostgreJS', async () => {
    const { Knex } = await import('../_support/native.js');
    const db = Knex();
    try {
      const result = await db.raw('select 9007199254740993::int8 as v');
      expect(result.rows[0].v).toBe(9007199254740993n);
    } finally {
      await db.destroy();
    }
  });
});
