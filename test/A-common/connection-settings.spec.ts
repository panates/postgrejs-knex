import { expect } from 'expect';
import { toConnectionConfiguration } from '../../src/index.js';

/** Collects what was warned about, so a test can assert on it. */
function collector(): { warnings: string[]; warn: (m: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: m => warnings.push(m) };
}

describe('connection-settings', () => {
  it('passes the options both clients spell the same way through', () => {
    const { warn, warnings } = collector();
    const config = toConnectionConfiguration(
      {
        host: 'db.example.com',
        user: 'app',
        password: 'secret',
        database: 'shop',
        ssl: { rejectUnauthorized: false },
      },
      warn,
    );
    expect(config).toEqual({
      host: 'db.example.com',
      user: 'app',
      password: 'secret',
      database: 'shop',
      ssl: { rejectUnauthorized: false },
    });
    expect(warnings).toEqual([]);
  });

  it('reads the port as a number, which a parsed URL gives as a string', () => {
    const { warn } = collector();
    expect(toConnectionConfiguration({ port: '5433' }, warn).port).toBe(5433);
    expect(toConnectionConfiguration({ port: 5433 }, warn).port).toBe(5433);
  });

  it('renames application_name', () => {
    const { warn } = collector();
    expect(
      toConnectionConfiguration({ application_name: 'shop' }, warn)
        .applicationName,
    ).toBe('shop');
  });

  it('renames connectionTimeoutMillis', () => {
    const { warn } = collector();
    expect(
      toConnectionConfiguration({ connectionTimeoutMillis: 2000 }, warn)
        .connectTimeoutMs,
    ).toBe(2000);
  });

  it('lets application_name win over the fallback, as pg does', () => {
    const { warn } = collector();
    const config = toConnectionConfiguration(
      { application_name: 'shop', fallback_application_name: 'other' },
      warn,
    );
    expect(config.applicationName).toBe('shop');
  });

  it('uses the fallback name when there is no other', () => {
    const { warn } = collector();
    expect(
      toConnectionConfiguration({ fallback_application_name: 'other' }, warn)
        .applicationName,
    ).toBe('other');
  });

  it('says so rather than dropping an option it cannot honour', () => {
    const { warn, warnings } = collector();
    const config = toConnectionConfiguration(
      { statement_timeout: 5000, host: 'db' },
      warn,
    );
    expect(config).toEqual({ host: 'db' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('statement_timeout');
  });

  it('warns about each pg option that has no equivalent', () => {
    const { warn, warnings } = collector();
    toConnectionConfiguration(
      {
        statement_timeout: 1,
        query_timeout: 1,
        idle_in_transaction_session_timeout: 1,
        lock_timeout: 1,
        options: '-c x=1',
        types: {},
        stream: () => undefined,
        Promise,
      },
      warn,
    );
    expect(warnings).toHaveLength(8);
  });

  it('passes a PostgreJS-only setting through untouched', () => {
    const { warn, warnings } = collector();
    const config = toConnectionConfiguration(
      { schema: 'app', timezone: 'UTC', asyncErrorHandling: false },
      warn,
    );
    expect(config).toEqual({
      schema: 'app',
      timezone: 'UTC',
      asyncErrorHandling: false,
    });
    expect(warnings).toEqual([]);
  });

  it('leaves out an option that was set to undefined', () => {
    const { warn } = collector();
    expect(
      Object.keys(toConnectionConfiguration({ host: undefined }, warn)),
    ).toEqual([]);
  });

  it('keeps a connection string, which PostgreJS reads itself', () => {
    const { warn } = collector();
    expect(
      toConnectionConfiguration(
        { connectionString: 'postgres://localhost/db' },
        warn,
      ).connectionString,
    ).toBe('postgres://localhost/db');
  });
});
