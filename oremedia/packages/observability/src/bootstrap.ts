import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import * as Sentry from '@sentry/node';
import { createLogger, type Logger } from './logger';

export interface TelemetryOptions {
  service: string;
  version?: string;
  env?: string;
}

let sdk: NodeSDK | null = null;

/**
 * Spec 3.1 observability: OpenTelemetry traces/metrics/logs, Sentry for errors, pino structured logs.
 * Exporters are enabled only when their endpoints are configured, so tests and scripts run without them.
 */
export function startTelemetry(opts: TelemetryOptions): Logger {
  const log = createLogger({ service: opts.service, env: opts.env });
  const otlp = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (otlp && !sdk) {
    sdk = new NodeSDK({
      serviceName: opts.service,
      traceExporter: new OTLPTraceExporter({ url: `${otlp.replace(/\/$/, '')}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${otlp.replace(/\/$/, '')}/v1/metrics` }),
      }),
      instrumentations: [
        getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } }),
      ],
    });
    sdk.start();
  }
  const dsn = process.env['SENTRY_DSN'];
  if (dsn) {
    Sentry.init({
      dsn,
      environment: opts.env ?? process.env['NODE_ENV'] ?? 'development',
      release: opts.version,
      beforeSend(event) {
        // Never ship request bodies, cookies or headers (spec 18: secrets absent from logs).
        if (event.request) {
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.headers;
          // Query strings can carry tokens (reviewer links, API keys); keep the path only.
          delete event.request.query_string;
          if (event.request.url) event.request.url = event.request.url.split('?')[0];
        }
        return event;
      },
    });
  }
  return log;
}

export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = null;
  await Sentry.flush(2000);
}

export const captureException = (err: unknown, context?: Record<string, string | number>): void => {
  Sentry.captureException(err, context ? { tags: context } : undefined);
};
