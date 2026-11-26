import { expect } from 'expect';
import { BindParam } from 'postgrejs';
import { toBindParam, toBindParams } from '../../src/index.js';

/** The OID and value a parameter went out with. */
function sent(value: unknown): { oid?: number; value: unknown } {
  const param = toBindParam(value);
  return param instanceof BindParam
    ? { oid: param.oid, value: param.value }
    : { value: param };
}

describe('params', () => {
  describe('toBindParam', () => {
    it('declares no type for a number', () => {
      expect(sent(42)).toEqual({ oid: 0, value: 42 });
    });

    it('declares no type for a boolean', () => {
      expect(sent(true)).toEqual({ oid: 0, value: true });
    });

    it('declares no type for a bigint', () => {
      expect(sent(42n)).toEqual({ oid: 0, value: 42n });
    });

    it('declares no type for null', () => {
      expect(sent(null)).toEqual({ oid: 0, value: null });
    });

    it('declares no type for undefined', () => {
      expect(sent(undefined)).toEqual({ oid: 0, value: undefined });
    });

    it('renders a plain object as JSON, as pg does', () => {
      expect(sent({ a: 1, b: [2] })).toEqual({
        oid: 0,
        value: '{"a":1,"b":[2]}',
      });
    });

    it('renders an object through its own toPostgres', () => {
      const point = {
        x: 1,
        y: 2,
        toPostgres() {
          return `(${this.x},${this.y})`;
        },
      };
      expect(sent(point)).toEqual({ oid: 0, value: '(1,2)' });
    });

    it('hands a string over, which PostgreJS already sends untyped', () => {
      expect(sent('text')).toEqual({ value: 'text' });
    });

    it('hands a Date over, so its own encoder runs', () => {
      const date = new Date('2024-03-05T12:30:00Z');
      expect(sent(date)).toEqual({ value: date });
    });

    it('hands a Buffer over, so its own encoder runs', () => {
      const buffer = Buffer.from('hi');
      expect(sent(buffer)).toEqual({ value: buffer });
    });

    it('hands an array over, so its own encoder runs', () => {
      expect(sent([1, 2, 3])).toEqual({ value: [1, 2, 3] });
    });

    it('hands a typed array over rather than reading it as an object', () => {
      const view = new Uint8Array([1, 2]);
      expect(sent(view)).toEqual({ value: view });
    });
  });

  describe('toBindParams', () => {
    it('answers undefined when there is nothing to bind', () => {
      expect(toBindParams(undefined, true)).toBeUndefined();
      expect(toBindParams([], true)).toBeUndefined();
    });

    it('wraps every binding that needs it', () => {
      const params = toBindParams([1, 'a', null], true)!;
      expect(params).toHaveLength(3);
      expect(params[0]).toBeInstanceOf(BindParam);
      expect(params[1]).toBe('a');
      expect(params[2]).toBeInstanceOf(BindParam);
    });

    it('hands every value over when inferParameterTypes is off', () => {
      const bindings = [1, 'a', null, { a: 1 }];
      expect(toBindParams(bindings, false)).toEqual(bindings);
    });

    it('copies rather than returning what it was given', () => {
      const bindings = [1];
      expect(toBindParams(bindings, false)).not.toBe(bindings);
    });
  });
});
