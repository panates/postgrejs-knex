import type { ConnectionConfiguration } from 'postgrejs';

/**
 * `pg` connection options that have no PostgreJS equivalent, with what to
 * say about each one.
 */
/* An option that is quietly dropped is worse than one that is refused: the
   connection comes up, the queries run, and the timeout the operator set
   never fires. These are warned about once per connection rather than
   ignored. Each is a real `pg` option a Knex configuration may carry, not a
   guess at what someone might write. */
const UNSUPPORTED: Record<string, string> = {
  statement_timeout:
    'no PostgreJS equivalent - run "set statement_timeout" from pool.afterCreate, or pass an AbortSignal per query',
  query_timeout:
    "no PostgreJS equivalent - use Knex's own .timeout() on the query",
  idle_in_transaction_session_timeout:
    'no PostgreJS equivalent - run "set idle_in_transaction_session_timeout" from pool.afterCreate',
  lock_timeout:
    'no PostgreJS equivalent - run "set lock_timeout" from pool.afterCreate',
  options: 'no PostgreJS equivalent for libpq startup options',
  types: 'pg type parsers do not apply - use postgrejs.typeMap instead',
  stream: 'pg-specific socket factory',
  Promise: 'pg-specific, and ignored by pg itself since 8.0',
};

/** `pg` option names PostgreJS spells differently. */
const RENAMED: Record<string, string> = {
  application_name: 'applicationName',
  fallback_application_name: 'applicationName',
  connectionTimeoutMillis: 'connectTimeoutMs',
};

/**
 * Knex's `connection` config as PostgreJS connection settings.
 *
 * @param settings What Knex resolved, which is `pg`-shaped.
 * @param warn Called once per option that cannot be honoured.
 * @returns Settings for a PostgreJS `Connection`.
 */
/* A Knex user writes `pg`'s option names, and a connection string Knex
   parses with `pg-connection-string` arrives as `pg`'s keys too - including
   `port` as a string, which PostgreJS wants as a number. Anything this does
   not recognise is passed through untouched, so every PostgreJS-only
   setting (`schema`, `timezone`, `hosts`, `targetSessionAttrs`,
   `channelBinding`, `prepare`, `asyncErrorHandling`, ...) can be written in
   the same object without a second channel for it. */
export function toConnectionConfiguration(
  settings: Record<string, any>,
  warn: (message: string) => void,
): ConnectionConfiguration {
  const config: Record<string, any> = {};
  /* Every own key, not every enumerable one: Knex hides `password` with
     `Object.defineProperty(..., { enumerable: false })` before the settings
     ever reach a client, so `Object.keys` leaves it out and the connection
     goes out without one. Against a server that trusts local connections
     that failure is silent, which is how it earned a test of its own. */
  for (const key of Object.getOwnPropertyNames(settings)) {
    const value = settings[key];
    if (value === undefined) continue;
    const unsupported = UNSUPPORTED[key];
    if (unsupported) {
      warn(
        `knex-postgrejs: ignoring connection option "${key}": ${unsupported}`,
      );
      continue;
    }
    const renamed = RENAMED[key];
    if (renamed) {
      // `fallback_application_name` only applies when the primary one is
      // absent, which is what `pg` does with it too.
      if (config[renamed] === undefined) config[renamed] = value;
      continue;
    }
    if (key === 'port') {
      config.port = typeof value === 'string' ? Number(value) : value;
      continue;
    }
    config[key] = value;
  }
  return config as ConnectionConfiguration;
}
