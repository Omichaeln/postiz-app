import { getDb, type Tx } from './client';

/**
 * The unit-of-work export of packages/db (spec 7.1). Application commands accept the `tx` it provides
 * and never import the raw client. `withTransaction(outer, fn)` joins an outer transaction when present,
 * so a command can run inside the idempotent() wrapper's transaction.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
export function withTransaction<T>(outer: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T>;
export function withTransaction<T>(
  a: Tx | undefined | ((tx: Tx) => Promise<T>),
  b?: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof a === 'function') return getDb().transaction((tx) => a(tx));
  const fn = b as (tx: Tx) => Promise<T>;
  if (a) return fn(a);
  return getDb().transaction((tx) => fn(tx));
}
