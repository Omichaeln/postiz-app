import { and, asc, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { affectedRows } from '@oremedia/db';
import { getDb } from '@oremedia/db/client';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { METRIC, count, gauge, logger } from '@oremedia/observability';
import { outboxRouteFor, type OutboxEventRecord, type WorkflowStartRequest } from './outbox-routes';

/**
 * Spec 14.2: portable lease-based outbox dispatch (no SKIP LOCKED), run by worker-core. This is platform-level code
 * that legitimately spans tenants and is the one allowlisted exception to the no-raw-db rule.
 */

export interface WorkflowStarter {
  start(req: WorkflowStartRequest & { tenantId: string; correlationId: string }): Promise<void>;
}

export interface DispatchOptions {
  workerId: string;
  starter: WorkflowStarter;
  batchSize?: number;
  leaseSeconds?: number;
  now?: () => Date;
}

export interface DispatchSummary {
  claimed: number;
  dispatched: number;
  ignored: number;
  failed: number;
}

/** Events that keep failing surface in the dead-letter view at this many attempts (spec 14.2 alerting). */
export const DEAD_LETTER_ATTEMPTS = 5;

const MAX_BACKOFF_MS = 15 * 60 * 1000;

/** 5 s · 2^attempts with ±10 % jitter, capped at 15 minutes. */
export function backoffFor(attempts: number, now: Date, random: () => number = Math.random): Date {
  const base = Math.min(5_000 * 2 ** Math.min(attempts, 20), MAX_BACKOFF_MS);
  const jitter = 1 + (random() * 2 - 1) * 0.1;
  return new Date(now.getTime() + Math.round(base * jitter));
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

const LOCK_ERROR_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

const isLockError = (err: unknown): boolean => {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const e = current as { code?: string; cause?: unknown };
    if (e.code && LOCK_ERROR_CODES.has(e.code)) return true;
    current = e.cause;
  }
  return false;
};

/**
 * Concurrent `UPDATE … ORDER BY … LIMIT` claims can deadlock on InnoDB's index locks; the victim is rolled back
 * atomically, so retrying the statement is safe (spec 14.2 avoids SKIP LOCKED for TiDB portability).
 */
async function withLockRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isLockError(err) || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 40)));
    }
  }
}

const toRecord = (row: typeof outboxEvents.$inferSelect): OutboxEventRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  aggregateType: row.aggregateType,
  aggregateId: row.aggregateId,
  aggregateVersion: row.aggregateVersion,
  eventType: row.eventType,
  schemaVersion: row.schemaVersion,
  payload: row.payload,
  correlationId: row.correlationId,
  attempts: row.attempts,
  availableAt: row.availableAt,
  createdAt: row.createdAt,
});

export async function dispatchBatch(opts: DispatchOptions): Promise<DispatchSummary> {
  const db = getDb();
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 100;
  const leaseUntil = new Date(now().getTime() + (opts.leaseSeconds ?? 60) * 1000);
  const log = logger().child('outbox');

  await withLockRetry(() =>
    db
      .update(outboxEvents)
      .set({ claimedBy: opts.workerId, claimExpiresAt: leaseUntil })
      .where(
        and(
          isNull(outboxEvents.dispatchedAt),
          lte(outboxEvents.availableAt, now()),
          or(isNull(outboxEvents.claimedBy), lt(outboxEvents.claimExpiresAt, now())),
        ),
      )
      .orderBy(asc(outboxEvents.availableAt))
      .limit(batchSize),
  );

  const claimed = await db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.claimedBy, opts.workerId),
        isNull(outboxEvents.dispatchedAt),
        gt(outboxEvents.claimExpiresAt, now()),
      ),
    )
    .orderBy(asc(outboxEvents.availableAt));

  const summary: DispatchSummary = { claimed: claimed.length, dispatched: 0, ignored: 0, failed: 0 };

  for (const row of claimed) {
    const evt = toRecord(row);
    try {
      const route = outboxRouteFor(evt.eventType);
      const req = route ? route(evt) : null;
      if (req) {
        await opts.starter.start({ ...req, tenantId: evt.tenantId, correlationId: evt.correlationId });
        summary.dispatched += 1;
      } else {
        summary.ignored += 1;
      }
      // The start happened, so the row is dispatched whoever holds the lease now: keying the mark on the lease
      // (as the spec sketch does) can leave a started event undispatched until the lease expires and then start it
      // again. Starts are idempotent (stable workflow ids, USE_EXISTING), so a lost lease costs at most a no-op
      // duplicate start, never a lost or twice-recorded event; a mark that finds the row already dispatched is
      // that duplicate and is logged.
      const marked = affectedRows(
        await withLockRetry(() =>
          db
            .update(outboxEvents)
            .set({ dispatchedAt: now() })
            .where(and(eq(outboxEvents.id, evt.id), isNull(outboxEvents.dispatchedAt))),
        ),
      );
      if (marked === 0)
        log.warn(
          { correlationId: evt.correlationId, tenantId: evt.tenantId },
          'outbox event was already marked dispatched by another worker (duplicate start absorbed)',
        );
      count(METRIC.outboxDispatched, 1, { eventType: evt.eventType, routed: req ? 'yes' : 'no' });
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await withLockRetry(() =>
        db
          .update(outboxEvents)
          .set({
            attempts: sql`${outboxEvents.attempts} + 1`,
            lastError: truncate(message, 1000),
            claimedBy: null,
            claimExpiresAt: null,
            availableAt: backoffFor(evt.attempts, now()),
          })
          .where(eq(outboxEvents.id, evt.id)),
      );
      count(METRIC.outboxDispatchFailures, 1, { eventType: evt.eventType });
      log.warn(
        {
          correlationId: evt.correlationId,
          tenantId: evt.tenantId,
          errorMessage: message,
          attempts: evt.attempts + 1,
        },
        'outbox dispatch failed; will retry',
      );
    }
  }
  return summary;
}

/** Age of the oldest undispatched event, or null when the outbox is drained (spec 17.2: alert above 60 s). */
export async function oldestUndispatchedAgeMs(now: Date = new Date()): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ availableAt: outboxEvents.availableAt })
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.dispatchedAt), lte(outboxEvents.availableAt, now)))
    .orderBy(asc(outboxEvents.availableAt))
    .limit(1);
  return row ? Math.max(0, now.getTime() - row.availableAt.getTime()) : null;
}

export interface DeadLetter {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  availableAt: Date;
  createdAt: Date;
}

/** Undispatched events at or beyond the dead-letter threshold (the runbook's dead-letter view). */
export interface DeadLetterFilter {
  minAttempts?: number;
  limit?: number;
  /** Set by the tenant-scoped API; the worker's platform view leaves it undefined. */
  tenantId?: string;
}

export async function listDeadLetters(filter: DeadLetterFilter = {}): Promise<DeadLetter[]> {
  const db = getDb();
  const minAttempts = filter.minAttempts ?? DEAD_LETTER_ATTEMPTS;
  const limit = filter.limit ?? 100;
  const rows = await db
    .select({
      id: outboxEvents.id,
      tenantId: outboxEvents.tenantId,
      eventType: outboxEvents.eventType,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      attempts: outboxEvents.attempts,
      lastError: outboxEvents.lastError,
      availableAt: outboxEvents.availableAt,
      createdAt: outboxEvents.createdAt,
    })
    .from(outboxEvents)
    .where(
      and(
        isNull(outboxEvents.dispatchedAt),
        sql`${outboxEvents.attempts} >= ${minAttempts}`,
        filter.tenantId ? eq(outboxEvents.tenantId, filter.tenantId) : undefined,
      ),
    )
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit);
  return rows;
}

/** Runbook replay: make the event claimable now. Attempts are kept so the history stays honest. */
export async function replayDeadLetter(
  id: string,
  opts: { tenantId?: string; now?: Date } = {},
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(outboxEvents)
    .set({ availableAt: opts.now ?? new Date(), claimedBy: null, claimExpiresAt: null, lastError: null })
    .where(
      and(
        eq(outboxEvents.id, id),
        isNull(outboxEvents.dispatchedAt),
        opts.tenantId ? eq(outboxEvents.tenantId, opts.tenantId) : undefined,
      ),
    );
  return affectedRows(result) === 1;
}

/** Observable gauges for the alerts in spec 14.2 / 17.2: oldest undispatched age (> 60 s) and dead letters (≥ 5 attempts). */
export function registerOutboxGauges(): void {
  gauge(METRIC.outboxOldestAgeMs, async () => [{ value: (await oldestUndispatchedAgeMs()) ?? 0 }]);
  gauge(METRIC.outboxDeadLetters, async () => [{ value: (await listDeadLetters()).length }]);
}
