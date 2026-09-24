import {
  customerVoiceClusters,
  insights,
  learningRecords,
  playbookEntries,
  recommendations,
} from '@oremedia/db/schema/intelligence';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * Per tenant, on brand 1: an active insight, a proposed recommendation with its learning record, a proposed
 * playbook entry and one voice cluster, so a foreign caller has every intelligence id to try (spec 19.3).
 */
export const INTELLIGENCE_SEED: SeedExtension = async (db, { tenantId, brandIds }) => {
  const brandId = brandIds[0];
  const insightId = newId('insight');
  const recommendationId = newId('recommendation');
  const learningRecordId = newId('learningRecord');
  const playbookEntryId = newId('playbookEntry');
  const voiceClusterId = newId('customerVoiceCluster');
  const periodStart = new Date('2026-09-01T00:00:00Z');
  const periodEnd = new Date('2026-09-08T00:00:00Z');
  await db.insert(insights).values({
    id: insightId,
    tenantId,
    brandId,
    kind: 'change',
    statement: 'Seeded movement',
    evidence: [{ kind: 'metric_key', ref: 'qualified_enquiries' }],
    strength: 'observed',
    periodStart,
    periodEnd,
    state: 'active',
    agentRunId: null,
  });
  await db.insert(recommendations).values({
    id: recommendationId,
    tenantId,
    brandId,
    insightIds: [insightId],
    proposedAction: 'create_brief',
    title: 'Seeded recommendation',
    rationale: 'Seeded rationale',
    expectedBenefit: { metricKey: 'qualified_enquiries', direction: 'up' },
    effort: 'low',
    uncertainty: 'medium',
    rank: 1,
    rankingPolicy: 'baseline',
    state: 'proposed',
    agentRunId: null,
  });
  await db.insert(learningRecords).values({
    id: learningRecordId,
    tenantId,
    brandId,
    recommendationId,
    contextRef: 'seed',
    evidenceRef: `insights:${insightId}`,
    hypothesis: 'Seeded rationale',
    action: 'create_brief',
    humanDecision: 'pending',
    verdict: 'pending',
  });
  await db.insert(playbookEntries).values({
    id: playbookEntryId,
    tenantId,
    brandId,
    practice: 'Seeded practice',
    evidenceIds: [insightId],
    strength: 'observed',
    approvedByUserId: null,
    reviewAfter: new Date('2030-01-01T00:00:00Z'),
    state: 'proposed',
  });
  await db.insert(customerVoiceClusters).values({
    id: voiceClusterId,
    tenantId,
    brandId,
    label: 'Seeded question',
    kind: 'question',
    size: 1,
    sampleMessageRefs: [newId('message')],
    centroid: null,
    linkedRecommendationIds: [],
    firstSeen: periodStart,
    lastSeen: periodEnd,
  });
  return { insightId, recommendationId, learningRecordId, playbookEntryId, voiceClusterId };
};
