import { z } from 'zod';

/** Spec 7.7: every outbox event is published in this envelope. Consumers are idempotent on eventId. */
export const EventEnvelope = z.object({
  eventId: z.string(), // evt_...
  eventType: z.string(), // 'publication.scheduled', 'creative.revision_created', ...
  schemaVersion: z.number().int(),
  tenantId: z.string(),
  brandId: z.string().optional(),
  aggregate: z.object({ type: z.string(), id: z.string(), version: z.number().int() }),
  correlationId: z.string(),
  occurredAt: z.string().datetime(),
  data: z.record(z.unknown()), // references and small scalars only
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Event catalogue (docs/contracts/events.md is generated from this). Additive changes only. */
export const EVENT_TYPES = {
  'tenant.created': 1,
  'membership.changed': 1,
  'brand.version_published': 1,
  'brand.fact_revoked': 1,
  'asset.upload_completed': 1,
  'asset.ingested': 1,
  'asset.retired': 1,
  'creative.revision_created': 1,
  'creative.render_requested': 1,
  'creative.render_completed': 1,
  'content.revision_created': 1,
  'review.requested': 1,
  'review.decided': 1,
  'approval.granted': 1,
  'approval.invalidated': 1,
  'publication.scheduled': 1,
  'publication.rescheduled': 1,
  'publication.cancel_requested': 1,
  'publication.state_changed': 1,
  'agent.run_requested': 1,
  'agent.run_finished': 1,
  'measurement.collection_due': 1,
  'intelligence.analysis_due': 1,
  'experiment.started': 1,
  'operations.deletion_requested': 1,
} as const;
export type EventType = keyof typeof EVENT_TYPES;
