import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchBatch, registerOutboxGauges, type WorkflowStarter } from '@oremedia/module-operations';
import { logger } from '@oremedia/observability';

export interface DispatchLoopOptions {
  workerId: string;
  starter: WorkflowStarter;
  /** Idle poll interval; a full batch is followed immediately by another pass. */
  intervalMs?: number;
  batchSize?: number;
  signal: AbortSignal;
}

/** Runs dispatchBatch until aborted; errors are logged and the loop continues (the outbox is retried, never lost). */
export async function runDispatchLoop(opts: DispatchLoopOptions): Promise<void> {
  const log = logger().child('outbox');
  const intervalMs = opts.intervalMs ?? 1_000;
  const batchSize = opts.batchSize ?? 100;
  registerOutboxGauges();
  while (!opts.signal.aborted) {
    let full = false;
    try {
      const summary = await dispatchBatch({ workerId: opts.workerId, starter: opts.starter, batchSize });
      full = summary.claimed >= batchSize;
    } catch (err) {
      log.error(
        { errorMessage: err instanceof Error ? err.message : String(err) },
        'outbox dispatch pass failed',
      );
    }
    if (!full) {
      try {
        await sleep(intervalMs, undefined, { signal: opts.signal });
      } catch {
        // aborted while idle
      }
    }
  }
}
