import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { METRIC, count, record } from './telemetry';

/** Collects on demand (no exporter): what the OTLP exporter would receive. */
class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NAMES = new Set<string>(Object.values(METRIC));
const JOURNEYS = ['schedule', 'dispatch', 'render', 'agent_run', 'ingest'];
const QUESTIONS = ['up', 'fast', 'erroring', 'keeping_up'];

interface Panel {
  type: string;
  oremediaJourney?: string;
  oremediaQuestion?: string;
  targets?: Array<{ expr: string; oremediaMetric: string }>;
}

describe('spec 17.3 metric names, the SLO dashboard and docs/operations/slos.md', () => {
  it('names are unique, stable and namespaced', () => {
    expect(NAMES.size).toBe(Object.keys(METRIC).length);
    for (const n of NAMES) expect(n).toMatch(/^oremedia\.[a-z_]+\.[a-z_]+$/);
  });

  it('the Phase 7 journey metrics exist: dispatch lag, publication outcomes, render, agent run, ingest lag', () => {
    expect(METRIC).toMatchObject({
      outboxDispatchLagMs: 'oremedia.outbox.dispatch_lag_ms',
      publicationOutcomes: 'oremedia.publish.outcomes',
      renderDurationMs: 'oremedia.render.duration_ms',
      renderJobs: 'oremedia.render.jobs',
      agentRunDurationMs: 'oremedia.agents.run_duration_ms',
      agentRunCostMicros: 'oremedia.agents.run_cost_micros',
      agentRuns: 'oremedia.agents.runs',
      ingestLagMs: 'oremedia.measurement.ingest_lag_ms',
    });
  });

  it('count and record reach the SDK as counters and histograms with their attributes', async () => {
    const reader = new TestReader();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    count(METRIC.publicationOutcomes, 1, { outcome: 'published' });
    count(METRIC.publicationOutcomes, 1, { outcome: 'failed' });
    record(METRIC.outboxDispatchLagMs, 1200, { eventType: 'publication.scheduled' });
    record(METRIC.ingestLagMs, 90_000, { outcome: 'written' });
    const { resourceMetrics } = await reader.collect();
    const points = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    const outcomes = points.find((m) => m.descriptor.name === METRIC.publicationOutcomes)!;
    expect(outcomes.dataPoints.map((p) => p.attributes['outcome']).sort()).toEqual(['failed', 'published']);
    const lag = points.find((m) => m.descriptor.name === METRIC.outboxDispatchLagMs)!;
    expect(lag.dataPoints[0]!.attributes).toEqual({ eventType: 'publication.scheduled' });
    expect((lag.dataPoints[0]!.value as { sum: number }).sum).toBe(1200);
    expect(points.some((m) => m.descriptor.name === METRIC.ingestLagMs)).toBe(true);
  });

  it('the dashboard is built only from METRIC names and answers the four questions for every journey', () => {
    const dash = JSON.parse(
      readFileSync(join(root, 'infra/observability/dashboards/oremedia-slos.json'), 'utf8'),
    ) as { panels: Panel[] };
    const panels = dash.panels.filter((p) => p.type !== 'row');
    for (const p of panels)
      for (const t of p.targets ?? []) {
        expect(NAMES.has(t.oremediaMetric), `${t.oremediaMetric} is not in METRIC`).toBe(true);
        // The PromQL uses the OTLP → Prometheus rendering of the same name.
        expect(t.expr).toContain(t.oremediaMetric.replace(/\./g, '_'));
        const other = [...t.expr.matchAll(/oremedia_[a-z_]+/g)].map((m) => m[0]);
        for (const o of other)
          expect(
            [...NAMES].some((n) => o.startsWith(n.replace(/\./g, '_'))),
            `${o} in ${t.expr}`,
          ).toBe(true);
      }
    for (const j of JOURNEYS)
      for (const q of QUESTIONS)
        expect(
          panels.some((p) => p.oremediaJourney === j && p.oremediaQuestion === q),
          `${j} lacks a ${q} panel`,
        ).toBe(true);
  });

  it('docs/operations/slos.md names only defined metrics', () => {
    const doc = readFileSync(join(root, 'docs/operations/slos.md'), 'utf8');
    const named = new Set([...doc.matchAll(/`(oremedia\.[a-z_]+\.[a-z_]+)`/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(10);
    expect([...named].filter((n) => !NAMES.has(n))).toEqual([]);
  });
});
