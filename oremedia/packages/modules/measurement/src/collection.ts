import type { ActivityHooks } from '@oremedia/contracts/agents';
import { NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type {
  MetricCollectionRuntimeV1,
  PullMetricsInputV1,
  PullMetricsResultV1,
} from '@oremedia/contracts/measurement';
import type { RawMetricPoint } from '@oremedia/contracts/providers';
import { withTransaction } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { logger } from '@oremedia/observability';
import { adapterFor, credentialBroker, providerIO } from '@oremedia/module-publishing';
import { collectionPlan, loadPublication, sourceOf } from './common';
import { definitionService } from './definitions';
import { comparableGroupFor, deriveRates, type RateInput } from './normalise';
import { MetricSnapshotRepository } from './repositories';

/**
 * Spec 15.1 collection runtime behind metricCollectionWorkflowV1 (task queue `ingest-metrics`): one pull writes
 * RAW `metric_snapshots` with source, fetched_at, the UTC window, the brand timezone and completeness. A metric
 * the provider cannot supply (not supported, scope missing, error) is a row with a null value, never zero. The
 * pull is idempotent per (publication, metric, window): a repeat of a written window writes nothing. Credentials
 * are opened by the broker inside the call and never enter Temporal; the adapter's rate limits apply through
 * ProviderIO exactly as for publishing.
 */
const snapshotsRepo = new MetricSnapshotRepository();

export interface MetricCollectionOptions {
  now?: () => Date;
}

const unavailablePoint = (nativeName: string, window: { start: string; end: string }): RawMetricPoint => ({
  nativeName,
  value: null,
  windowStart: window.start,
  windowEnd: window.end,
  completeness: 'unavailable',
});

export function createMetricCollectionRuntime(opts: MetricCollectionOptions = {}): MetricCollectionRuntimeV1 {
  const now = opts.now ?? (() => new Date());
  const log = logger().child('measurement');

  return {
    readCollectionPlan: ({ publicationId }) => collectionPlan(publicationId),

    async pullMetrics(input: PullMetricsInputV1, hooks?: ActivityHooks): Promise<PullMetricsResultV1> {
      const { tenantId, publicationId } = input;
      const { row, connection, brandTimezone } = await loadPublication(publicationId);
      const adapter = adapterFor(connection.providerKey);
      const window = { start: input.windowStart, end: input.windowEnd };
      const windowStart = new Date(window.start);
      const windowEnd = new Date(window.end);
      const expected = adapter.capability.analytics.post;
      const existing = new Set(
        (await snapshotsRepo.findForWindow(row.brandId, 'publication', row.id, windowStart, windowEnd)).map(
          (s) => s.metricKey,
        ),
      );
      if (expected.length > 0 && expected.every((k) => existing.has(k)))
        return { written: 0, skipped: expected.length, unavailable: 0 };

      let points: RawMetricPoint[];
      const fetchPostMetrics = adapter.fetchPostMetrics?.bind(adapter);
      if (!fetchPostMetrics || !row.remotePostId) {
        points = expected.map((n) => unavailablePoint(n, window));
      } else {
        try {
          points = await credentialBroker.withCredentials(tenantId, connection.id, (creds) => {
            hooks?.heartbeat(`metrics:${publicationId}:${input.pullIndex}`);
            return fetchPostMetrics(
              { remotePostId: row.remotePostId as string, window },
              creds,
              providerIO(adapter.key, tenantId, hooks),
            );
          });
        } catch (err) {
          // A permission or scoping failure is the caller's problem (non-retryable at the activity host);
          // anything the platform did is recorded as unavailable, never as zero.
          if (err instanceof PolicyDeniedError || err instanceof NotFoundError) throw err;
          log.warn(
            { publicationId, errorMessage: err instanceof Error ? err.message : String(err) },
            'metric pull failed; window recorded as unavailable',
          );
          points = expected.map((n) => unavailablePoint(n, window));
        }
      }
      // Every expected metric gets a row; a metric the adapter did not report is unavailable.
      const byName = new Map(points.map((p) => [p.nativeName, p]));
      for (const n of expected) if (!byName.has(n)) byName.set(n, unavailablePoint(n, window));

      const fetchedAt = now();
      const source = sourceOf(adapter.key, adapter.capability.version);
      return withTransaction(async (tx) => {
        let written = 0;
        let skipped = 0;
        let unavailable = 0;
        const rateInputs: RateInput[] = [];
        for (const point of byName.values()) {
          if (existing.has(point.nativeName)) {
            skipped += 1;
            continue;
          }
          const definition = await definitionService.resolve(point.nativeName, adapter.key, tx);
          const comparableGroup = definition?.comparableGroup ?? comparableGroupFor(point.nativeName);
          const isUnavailable =
            point.completeness === 'unavailable' || (point.value === null && !point.series);
          const id = newId('metricSnapshot');
          await snapshotsRepo.create(
            {
              id,
              brandId: row.brandId,
              subjectType: 'publication',
              subjectId: row.id,
              metricKey: point.nativeName,
              value: isUnavailable ? null : point.value,
              series: point.series ?? null,
              windowStart: new Date(point.windowStart || window.start),
              windowEnd: new Date(point.windowEnd || window.end),
              fetchedAt,
              source,
              completeness: isUnavailable ? 'unavailable' : point.completeness,
              definitionVersion: definition?.definitionVersion ?? 1,
              numeratorSnapshotId: null,
              denominatorSnapshotId: null,
              brandTimezone,
            },
            tx,
          );
          written += 1;
          if (isUnavailable) unavailable += 1;
          if (!point.series)
            rateInputs.push({
              snapshotId: id,
              comparableGroup,
              value: isUnavailable ? null : point.value,
              completeness: isUnavailable ? 'unavailable' : point.completeness,
            });
        }
        // Spec 15.2: derived rates store numerator and denominator snapshot ids.
        for (const rate of deriveRates(rateInputs)) {
          if (existing.has(rate.key)) continue;
          const definition = await definitionService.resolve(rate.key, null, tx);
          await snapshotsRepo.create(
            {
              id: newId('metricSnapshot'),
              brandId: row.brandId,
              subjectType: 'publication',
              subjectId: row.id,
              metricKey: rate.key,
              value: rate.value,
              series: null,
              windowStart,
              windowEnd,
              fetchedAt,
              source,
              completeness: rate.completeness,
              definitionVersion: definition?.definitionVersion ?? 1,
              numeratorSnapshotId: rate.numeratorSnapshotId,
              denominatorSnapshotId: rate.denominatorSnapshotId,
              brandTimezone,
            },
            tx,
          );
          written += 1;
          if (rate.completeness === 'unavailable') unavailable += 1;
        }
        return { written, skipped, unavailable };
      });
    },
  };
}
