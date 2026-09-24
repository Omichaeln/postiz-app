import { getDb, type Tx } from './client';

/** Thrown when code keeps using a transaction handle after its transaction committed or rolled back. */
export class TransactionClosedError extends Error {
  constructor(operation: string) {
    super(`transaction is closed: ${operation} was called after commit or rollback`);
    this.name = 'TransactionClosedError';
  }
}

/**
 * A transaction handle that stops working once its transaction has ended. The pool connection is released on
 * commit or rollback; without this guard a late query (a tool still running after its timeout rolled the unit of
 * work back) would run on a connection another caller may already hold.
 */
function guarded(tx: Tx): { handle: Tx; close(): void } {
  let closed = false;
  const handle = new Proxy(tx, {
    get(target, prop, receiver) {
      if (closed) throw new TransactionClosedError(String(prop));
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    handle,
    close: () => {
      closed = true;
    },
  };
}

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
  const fn = (typeof a === 'function' ? a : b) as (tx: Tx) => Promise<T>;
  if (typeof a !== 'function' && a) return fn(a);
  return getDb().transaction(async (tx) => {
    const g = guarded(tx);
    try {
      return await fn(g.handle);
    } finally {
      g.close();
    }
  });
}
