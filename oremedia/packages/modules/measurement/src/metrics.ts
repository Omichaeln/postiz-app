import type { z } from 'zod';
import { NotFoundError } from '@oremedia/contracts/errors';
import {
  EngagementQualityGet,
  MetricsQueryV1,
  type MetricAggregateV1,
  type MetricValueV1,
} from '@oremedia/contracts/measurement';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { BrandObjectiveRepository } from '@oremedia/module-brand';
import { PublicationRepository } from '@oremedia/module-publishing';
import { brandResource, latencyHoursFor, providerKeyOfSource } from './common';
import { definitionService } from './definitions';
import { assertBrandExists } from './hooks';
import {
  aggregateByComparableGroup,
  comparableGroupFor,
  coverageOf,
  freshnessOf,
  latestPerSubjectMetric,
} from './normalise';
import { engagementQuality, type QualityComponent, type QualityComponentInput } from './quality';
import { ConversationRepository, MessageRepository, MetricSnapshotRepository } from './repositories';

/**
 * Spec 15.2 query surface: values with freshness and completeness, aggregates only within a comparable_group,
 * and a coverage statement with every result. Spec 15.3: the engagement quality composite with drill-down.
 */
const snapshotsRepo = new MetricSnapshotRepository();
const conversationsRepo = new ConversationRepository();
const messagesRepo = new MessageRepository();
const objectivesRepo = new BrandObjectiveRepository();
const publicationsRepo = new PublicationRepository();

export interface MetricsQueryOptions {
  now?: () => Date;
}

type SnapshotRow = Awaited<ReturnType<MetricSnapshotRepository['getById']>>;

async function toValues(rows: SnapshotRow[], now: Date, tx?: Tx): Promise<MetricValueV1[]> {
  const groups = new Map<string, string>();
  const out: MetricValueV1[] = [];
  for (const s of rows) {
    const providerKey = providerKeyOfSource(s.source);
    const cacheKey = `${s.metricKey}@${providerKey}`;
    let comparableGroup = groups.get(cacheKey);
    if (!comparableGroup) {
      const definition =
        (await definitionService.resolve(s.metricKey, providerKey, tx)) ??
        (await definitionService.resolve(s.metricKey, null, tx));
      comparableGroup = definition?.comparableGroup ?? comparableGroupFor(s.metricKey);
      groups.set(cacheKey, comparableGroup);
    }
    out.push({
      snapshotId: s.id,
      subjectType: s.subjectType,
      subjectId: s.subjectId,
      metricKey: s.metricKey,
      comparableGroup,
      value: s.value,
      series: s.series ?? null,
      completeness: s.completeness,
      freshness: freshnessOf(s.fetchedAt, latencyHoursFor(providerKey), now),
      source: s.source,
      definitionVersion: s.definitionVersion,
      windowStart: s.windowStart.toISOString(),
      windowEnd: s.windowEnd.toISOString(),
      brandTimezone: s.brandTimezone,
      numeratorSnapshotId: s.numeratorSnapshotId,
      denominatorSnapshotId: s.denominatorSnapshotId,
    });
  }
  return out;
}

const groupBy = <T>(items: T[], key: (t: T) => string): Array<{ key: string; values: T[] }> => {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return [...m.entries()].map(([k, values]) => ({ key: k, values }));
};

export function createMetricService(opts: MetricsQueryOptions = {}) {
  const now = opts.now ?? (() => new Date());
  return {
    /** insight.read on the brand; the latest fetch per (subject, metric) inside the range is the number. */
    async query(actor: ResolvedActor, input: z.infer<typeof MetricsQueryV1>, tx?: Tx) {
      const parsed = MetricsQueryV1.parse(input);
      await assertBrandExists(parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      const rows = latestPerSubjectMetric(
        await snapshotsRepo.listForQuery(
          parsed.brandId,
          parsed.subjectType,
          parsed.subjectIds,
          parsed.metricKeys,
          windowStart,
          windowEnd,
          tx,
        ),
      );
      const at = now();
      const values = await toValues(rows, at, tx);
      const coverage = coverageOf(values, {
        subjectIds: parsed.subjectIds,
        metricKeys: parsed.metricKeys,
        windowStart,
        windowEnd,
      });
      let aggregates: MetricAggregateV1[] = [];
      let groups: Array<{ key: string; values: MetricValueV1[] }>;
      switch (parsed.grouping) {
        case 'comparable_group':
          aggregates = aggregateByComparableGroup(values);
          groups = groupBy(values, (v) => v.comparableGroup);
          break;
        case 'metric':
          groups = groupBy(values, (v) => v.metricKey);
          break;
        default:
          groups = groupBy(values, (v) => v.subjectId);
      }
      return {
        grouping: parsed.grouping,
        values,
        groups,
        aggregates,
        coverage,
        computedAt: at.toISOString(),
      };
    },

    /**
     * Spec 15.3: saves, shares and negative feedback from the latest snapshots of the publication; substantive
     * comments and repeat engagers from the ingested messages (classification by the intelligence module); weights
     * from the brand's active objective (engagement_quality_weights), default equal.
     */
    async quality(actor: ResolvedActor, input: z.infer<typeof EngagementQualityGet>, tx?: Tx) {
      const parsed = EngagementQualityGet.parse(input);
      await assertBrandExists(parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
      const publication = await publicationsRepo.getById(parsed.publicationId, tx);
      if (publication.brandId !== parsed.brandId)
        throw new NotFoundError('Publication', parsed.publicationId);
      const at = now();
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      const rows = latestPerSubjectMetric(
        await snapshotsRepo.listForQuery(
          parsed.brandId,
          'publication',
          [publication.id],
          await allMetricKeys(parsed.brandId, publication.id, windowStart, windowEnd, tx),
          windowStart,
          windowEnd,
          tx,
        ),
      );
      const values = await toValues(rows, at, tx);
      const fromGroup = (group: string): QualityComponentInput => {
        const list = values.filter(
          (v) =>
            v.comparableGroup === group &&
            v.series === null &&
            v.completeness !== 'unavailable' &&
            v.value !== null,
        );
        if (list.length === 0) return { value: null, evidence: [] };
        return {
          value: list.reduce((s, v) => s + (v.value as number), 0),
          evidence: list.map((v) => v.snapshotId),
        };
      };
      const impressions = fromGroup('impressions');
      const conversations = await conversationsRepo.listForPublication(parsed.brandId, publication.id, tx);
      const messages = await messagesRepo.listForConversations(
        parsed.brandId,
        conversations.map((c) => c.id),
        tx,
      );
      const classified = messages.filter((m) => m.substantive !== null);
      const substantive = classified.filter((m) => m.substantive === 'yes');
      const byAuthor = new Map<string, number>();
      for (const m of messages) byAuthor.set(m.authorHash, (byAuthor.get(m.authorHash) ?? 0) + 1);
      const repeat = [...byAuthor.entries()].filter(([, n]) => n > 1);
      const inputs: Record<QualityComponent, QualityComponentInput> = {
        saves: fromGroup('saves'),
        shares: fromGroup('shares'),
        substantive_comments:
          classified.length === 0
            ? { value: null, evidence: [] }
            : { value: substantive.length, evidence: substantive.map((m) => m.id) },
        repeat_engagers:
          messages.length === 0
            ? { value: null, evidence: [] }
            : { value: repeat.length, evidence: repeat.map(([hash]) => hash) },
        negative_feedback: fromGroup('negative_feedback'),
      };
      const objective = (await objectivesRepo.listActive(parsed.brandId, at, tx)).find(
        (o) => o.engagementQualityWeights,
      );
      const result = engagementQuality(
        inputs,
        objective?.engagementQualityWeights ?? null,
        impressions.value,
      );
      return {
        publicationId: publication.id,
        objectiveId: objective?.id ?? null,
        ...result,
        freshness: values.map((v) => ({ metricKey: v.metricKey, ...v.freshness })),
        coverage: coverageOf(values, {
          subjectIds: [publication.id],
          metricKeys: [...new Set(values.map((v) => v.metricKey))],
          windowStart,
          windowEnd,
        }),
        computedAt: at.toISOString(),
      };
    },
  };
}

/** The metric keys with any snapshot for the publication in the window (the composite reads them all). */
async function allMetricKeys(brandId: string, publicationId: string, from: Date, to: Date, tx?: Tx) {
  const keys = new Set<string>();
  for (const s of await snapshotsRepo.listKeysForSubject(brandId, 'publication', publicationId, from, to, tx))
    keys.add(s);
  return keys.size ? [...keys] : ['__none__'];
}

export const metricService = createMetricService();
