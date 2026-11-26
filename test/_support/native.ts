import type { Knex as KnexType } from 'knex';
import { openKnex } from './live.js';

/** A Knex instance on this client with PostgreJS's own decoding. */
export function Knex(): KnexType {
  return openKnex({ decoding: 'native' });
}
