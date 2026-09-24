import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';

/**
 * Spec 17.3 metrics. Names are stable; instruments are created lazily so packages can record without
 * bootstrapping the SDK (tests, scripts). The SDK is started by `startTelemetry` in each app entrypoint.
 */
const METER_NAME = 'oremedia';

export const tracer = (): Tracer => trace.getTracer(METER_NAME);
export const meter = (): Meter => metrics.getMeter(METER_NAME);

export const METRIC = {
  outboxOldestAgeMs: 'oremedia.outbox.oldest_undispatched_age_ms',
  outboxDeadLetters: 'oremedia.outbox.dead_letters',
  outboxDispatched: 'oremedia.outbox.dispatched',
  outboxDispatchFailures: 'oremedia.outbox.dispatch_failures',
  scheduleToStartMs: 'oremedia.temporal.schedule_to_start_ms',
  dispatchLatenessMs: 'oremedia.publish.dispatch_lateness_ms',
  renderDurationMs: 'oremedia.render.duration_ms',
  renderFailures: 'oremedia.render.failures',
  tokenRefreshFailures: 'oremedia.channels.token_refresh_failures',
  reconnectNeeded: 'oremedia.channels.reconnect_needed',
  providerRateLimitHits: 'oremedia.providers.rate_limit_hits',
  outcomeUnknownCount: 'oremedia.publish.outcome_unknown',
  outcomeUnknownAgeMs: 'oremedia.publish.outcome_unknown_age_ms',
  duplicateDetections: 'oremedia.publish.duplicate_detections',
  policyDenials: 'oremedia.policy.denials',
  modelSpendDriftMicros: 'oremedia.agents.spend_vs_reservation_drift_micros',
  approvalInvalidations: 'oremedia.review.approval_invalidations',
  staleAnalyticsShare: 'oremedia.measurement.stale_share',
  httpRequests: 'oremedia.http.requests',
  httpDurationMs: 'oremedia.http.duration_ms',
} as const;

const counters = new Map<string, ReturnType<Meter['createCounter']>>();
const histograms = new Map<string, ReturnType<Meter['createHistogram']>>();
const gauges = new Map<string, ReturnType<Meter['createObservableGauge']>>();

export function count(name: string, value = 1, attributes: Record<string, string | number> = {}): void {
  let c = counters.get(name);
  if (!c) {
    c = meter().createCounter(name);
    counters.set(name, c);
  }
  c.add(value, attributes);
}

export function record(name: string, value: number, attributes: Record<string, string | number> = {}): void {
  let h = histograms.get(name);
  if (!h) {
    h = meter().createHistogram(name);
    histograms.set(name, h);
  }
  h.record(value, attributes);
}

export function gauge(
  name: string,
  read: () => Promise<Array<{ value: number; attributes?: Record<string, string | number> }>>,
): void {
  if (gauges.has(name)) return;
  const g = meter().createObservableGauge(name);
  g.addCallback(async (result) => {
    for (const { value, attributes } of await read()) result.observe(value, attributes ?? {});
  });
  gauges.set(name, g);
}

/** Runs fn inside a span with the standard correlation attributes. */
export async function span<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (s) => {
    try {
      return await fn();
    } catch (err) {
      s.recordException(err as Error);
      s.setStatus({ code: 2 });
      throw err;
    } finally {
      s.end();
    }
  });
}
