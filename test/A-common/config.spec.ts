import { expect } from 'expect';
import { DataTypeOIDs } from 'postgrejs';
import { FETCH_AS_STRING_OIDS, resolveOptions } from '../../src/index.js';

describe('config', () => {
  it('decodes like pg when nothing says otherwise', () => {
    expect(resolveOptions(undefined).fetchAsString).toBe(FETCH_AS_STRING_OIDS);
  });

  it('asks for nothing as text under native decoding', () => {
    expect(
      resolveOptions({ decoding: 'native' }).fetchAsString,
    ).toBeUndefined();
  });

  it('appends extra OIDs to the pg list rather than replacing it', () => {
    const fetchAsString = resolveOptions({
      fetchAsString: [DataTypeOIDs.oid],
    }).fetchAsString!;
    expect(fetchAsString).toHaveLength(FETCH_AS_STRING_OIDS.length + 1);
    expect(fetchAsString.at(-1)).toBe(DataTypeOIDs.oid);
  });

  it('asks for only the extra OIDs under native decoding', () => {
    expect(
      resolveOptions({
        decoding: 'native',
        fetchAsString: [DataTypeOIDs.oid],
      }).fetchAsString,
    ).toEqual([DataTypeOIDs.oid]);
  });

  it('leaves parameter types to the server unless told not to', () => {
    expect(resolveOptions(undefined).inferParameterTypes).toBe(true);
    expect(
      resolveOptions({ inferParameterTypes: true }).inferParameterTypes,
    ).toBe(true);
    expect(
      resolveOptions({ inferParameterTypes: false }).inferParameterTypes,
    ).toBe(false);
  });

  it('normalizes errors unless told not to', () => {
    expect(resolveOptions(undefined).normalizeErrors).toBe(true);
    expect(resolveOptions({ normalizeErrors: false }).normalizeErrors).toBe(
      false,
    );
  });

  it("aborts a transaction on error, which is PostgreSQL's own behaviour", () => {
    expect(resolveOptions(undefined).rollbackOnError).toBe(false);
    expect(resolveOptions({ rollbackOnError: true }).rollbackOnError).toBe(
      true,
    );
  });

  it('leaves prepare and typeMap unset unless they were given', () => {
    const resolved = resolveOptions(undefined);
    expect(resolved.prepare).toBeUndefined();
    expect(resolved.typeMap).toBeUndefined();
  });
});
