import { expect } from 'expect';
import * as api from '../../src/index.js';

describe('index', () => {
  it('exports what the README tells people to import', () => {
    expect(typeof api.PostgrejsClient).toBe('function');
    expect(typeof api.resolveOptions).toBe('function');
    expect(typeof api.toQueryResult).toBe('function');
    expect(typeof api.toBindParam).toBe('function');
    expect(typeof api.toBindParams).toBe('function');
    expect(typeof api.normalizeError).toBe('function');
    expect(typeof api.toConnectionConfiguration).toBe('function');
    expect(typeof api.createRowStream).toBe('function');
    expect(api.UNSPECIFIED_OID).toBe(0);
    expect(Array.isArray(api.FETCH_AS_STRING_OIDS)).toBe(true);
  });

  it('is a Knex client, so knex() takes it as one', () => {
    expect(api.PostgrejsClient.prototype.driverName).toBe('pg');
    expect(api.PostgrejsClient.prototype.dialect).toBe('postgresql');
  });
});
