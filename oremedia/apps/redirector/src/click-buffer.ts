import { createHmac } from 'node:crypto';

/**
 * Spec 15.4: clicks are buffered and flushed in batches so a redirect never waits on the database; a flush failure
 * is logged and retried on the next tick (the batch is kept, bounded). The visitor id is a keyed hash of
 * IP + user agent + a daily salt, so the same visitor is stable for a day and never identifiable afterwards.
 */
/** Mirrors link_clicks (@oremedia/db/schema/measurement); kept dependency-free so the buffer is unit-testable alone. */
export interface ClickRow {
  id: string;
  tenantId: string;
  brandId: string;
  trackedLinkId: string;
  visitorHash: string;
  occurredAt: Date;
}
export interface BufferLog {
  warn(fields: Record<string, unknown>, msg: string): void;
}

export function visitorHash(secret: string, ip: string, userAgent: string, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const salt = createHmac('sha256', secret).update(`salt:${day}`).digest('hex');
  return createHmac('sha256', salt).update(`${ip}|${userAgent}`).digest('hex');
}

export interface ClickBufferOptions {
  flushIntervalMs?: number;
  maxBatch?: number;
  /** Rows beyond this are dropped with a log line rather than growing memory during an outage. */
  maxBuffered?: number;
  write(rows: ClickRow[]): Promise<void>;
  log?: BufferLog;
}

export function createClickBuffer(opts: ClickBufferOptions) {
  const log: BufferLog = opts.log ?? { warn: () => undefined };
  const flushIntervalMs = opts.flushIntervalMs ?? 1000;
  const maxBatch = opts.maxBatch ?? 500;
  const maxBuffered = opts.maxBuffered ?? 50_000;
  let pending: ClickRow[] = [];
  let flushing = false;
  let timer: NodeJS.Timeout | null = null;

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const batch = pending.slice(0, maxBatch);
    try {
      await opts.write(batch);
      pending = pending.slice(batch.length);
    } catch (err) {
      log.warn(
        { errorMessage: err instanceof Error ? err.message : String(err), count: batch.length },
        'click flush failed; retrying',
      );
    } finally {
      flushing = false;
    }
  }

  return {
    add(row: ClickRow): void {
      if (pending.length >= maxBuffered) {
        log.warn({ count: pending.length }, 'click buffer full; dropping a click');
        return;
      }
      pending.push(row);
    },
    start(): void {
      if (!timer) timer = setInterval(() => void flush(), flushIntervalMs);
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      while (pending.length > 0) await flush();
    },
    flush,
    size: () => pending.length,
  };
}

export type ClickBuffer = ReturnType<typeof createClickBuffer>;
