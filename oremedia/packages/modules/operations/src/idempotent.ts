import { and, eq } from 'drizzle-orm';
import { IdempotencyInProgressError, IdempotencyKeyReusedError } from '@oremedia/contracts/errors';
import { requireTenant, withTransaction, TenantScopedRepository, type Tx } from '@oremedia/db';
import { idempotencyKeys } from '@oremedia/db/schema/operations';

export interface MutationContext {
  idempotency: { key: string; path: string; requestHash: string };
  actor: { kind: string; id: string };
  /** Stored 24 hours; 72 hours for publication commands (spec 7.3). */
  ttlHours?: number;
}

const IN_PROGRESS_RETRY_MS = 2000;

class IdempotencyRepository extends TenantScopedRepository<typeof idempotencyKeys & { id: never }> {
  constructor() {
    // idempotency_keys has a composite primary key; the base class id helpers are not used.
    super(idempotencyKeys as never);
  }
  async lookup(principalId: string, key: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(idempotencyKeys)
      .where(this.scope(and(eq(idempotencyKeys.principalId, principalId), eq(idempotencyKeys.key, key))))
      .limit(1);
    return rows[0] ?? null;
  }
  async insertInProgress(
    principalId: string,
    key: string,
    path: string,
    requestHash: string,
    expiresAt: Date,
    tx: Tx,
  ) {
    const { tenantId } = requireTenant();
    await this.conn(tx)
      .insert(idempotencyKeys)
      .values({ tenantId, principalId, key, path, requestHash, state: 'in_progress', expiresAt });
  }
  async complete(principalId: string, key: string, responseBody: unknown, tx: Tx) {
    await this.conn(tx)
      .update(idempotencyKeys)
      .set({ state: 'completed', responseStatus: 200, responseBody: responseBody as never })
      .where(this.scope(and(eq(idempotencyKeys.principalId, principalId), eq(idempotencyKeys.key, key))));
  }
  async remove(principalId: string, key: string, tx?: Tx) {
    await this.conn(tx)
      .delete(idempotencyKeys)
      .where(this.scope(and(eq(idempotencyKeys.principalId, principalId), eq(idempotencyKeys.key, key))));
  }
}

const repo = new IdempotencyRepository();

function isDuplicateKeyError(err: unknown): boolean {
  return (
    (err as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY' ||
    (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ER_DUP_ENTRY'
  );
}
function isLockWaitError(err: unknown): boolean {
  const code =
    (err as { code?: string } | undefined)?.code ??
    (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === 'ER_LOCK_WAIT_TIMEOUT' || code === 'ER_LOCK_DEADLOCK';
}

/**
 * Spec 7.1 / 7.3. Sequence:
 *  1. lookup: completed + same hash → replay; different hash or path → IDEMPOTENCY_KEY_REUSED; in_progress → 409 retryAfterMs;
 *  2. the in_progress marker commits in its own short transaction so a concurrent duplicate sees it (or loses the
 *     primary-key race → 409);
 *  3. the command runs in one transaction with the completion of the marker: the domain writes, the audit event,
 *     the outbox event and the stored response commit together, or none of them do;
 *  4. a failed command removes the marker so an honest retry can run.
 */
export async function idempotent<T>(ctx: MutationContext, command: (tx: Tx) => Promise<T>): Promise<T> {
  const { key, path, requestHash } = ctx.idempotency;
  const principalId = ctx.actor.id;
  const prior = await repo.lookup(principalId, key);
  if (prior) {
    if (prior.expiresAt.getTime() < Date.now()) {
      await repo.remove(principalId, key);
    } else if (prior.requestHash !== requestHash || prior.path !== path) {
      throw new IdempotencyKeyReusedError();
    } else if (prior.state === 'in_progress') {
      throw new IdempotencyInProgressError(IN_PROGRESS_RETRY_MS);
    } else {
      return prior.responseBody as T;
    }
  }
  const expiresAt = new Date(Date.now() + (ctx.ttlHours ?? 24) * 3600 * 1000);
  try {
    await withTransaction((tx) => repo.insertInProgress(principalId, key, path, requestHash, expiresAt, tx));
  } catch (err) {
    if (isDuplicateKeyError(err) || isLockWaitError(err)) {
      const again = await repo.lookup(principalId, key);
      if (again?.state === 'completed' && again.requestHash === requestHash && again.path === path)
        return again.responseBody as T;
      if (again && (again.requestHash !== requestHash || again.path !== path))
        throw new IdempotencyKeyReusedError();
      throw new IdempotencyInProgressError(IN_PROGRESS_RETRY_MS);
    }
    throw err;
  }
  try {
    return await withTransaction(async (tx) => {
      const result = await command(tx);
      await repo.complete(principalId, key, result, tx);
      return result;
    });
  } catch (err) {
    await repo.remove(principalId, key).catch(() => undefined);
    throw err;
  }
}
