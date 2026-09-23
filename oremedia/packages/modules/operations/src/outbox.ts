import type { EventType } from '@oremedia/contracts/events';
import { EVENT_TYPES } from '@oremedia/contracts/events';
import { TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';

class OutboxRepository extends TenantScopedRepository<typeof outboxEvents> {
  constructor() {
    super(outboxEvents);
  }
  async append(values: Omit<typeof outboxEvents.$inferInsert, 'tenantId'>, tx: Tx): Promise<void> {
    await this.insertScoped(values, tx);
  }
}

const repo = new OutboxRepository();

export interface OutboxAggregate {
  type: string;
  id: string;
  version: number;
}

/**
 * Spec 2.1.5 / 14.1: the event row commits in the same transaction as the domain write. `tx` is required, so a
 * caller cannot accidentally fire-and-forget outside the unit of work. Payloads carry references only.
 */
export const outbox = {
  async add(
    eventType: EventType,
    aggregate: OutboxAggregate,
    data: Record<string, string | number | boolean | null>,
    tx: Tx,
    opts?: { brandId?: string; availableAt?: Date },
  ): Promise<string> {
    const ctx = requireTenant();
    const id = newId('outboxEvent');
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.length > 500)
        throw new Error(`outbox payload field ${k} too large; payloads carry references only`);
    }
    await repo.append(
      {
        id,
        aggregateType: aggregate.type,
        aggregateId: aggregate.id,
        aggregateVersion: aggregate.version,
        eventType,
        schemaVersion: EVENT_TYPES[eventType],
        payload: { ...data, ...(opts?.brandId ? { brandId: opts.brandId } : {}) },
        correlationId: ctx.correlationId,
        availableAt: opts?.availableAt ?? new Date(),
      },
      tx,
    );
    return id;
  },
};
