import { outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** One dead-lettered outbox event per tenant so a foreign caller has an event id to try to replay. */
export const OPERATIONS_SEED: SeedExtension = async (db, { tenantId, brandIds }) => {
  const outboxEventId = newId('outboxEvent');
  await db.insert(outboxEvents).values({
    id: outboxEventId,
    tenantId,
    aggregateType: 'brand',
    aggregateId: brandIds[0],
    aggregateVersion: 1,
    eventType: 'brand.version_published',
    schemaVersion: 1,
    payload: { brandId: brandIds[0] },
    correlationId: 'seed',
    availableAt: new Date(),
    attempts: 5,
    lastError: 'seeded dead letter',
  });
  return { outboxEventId };
};
