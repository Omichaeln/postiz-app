import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureException, startTelemetry, stopTelemetry } from './bootstrap';
import { METRIC, count, tracer } from './telemetry';

/**
 * Spec 3.1 / 17.3: the exporters `startTelemetry` wires actually deliver. A local HTTP server stands in for the
 * OTLP collector and for Sentry's ingest endpoint; the test records what arrives and asserts traces and metrics
 * reach /v1/traces and /v1/metrics, and that an error event reaches Sentry without cookies, headers, body or query
 * string. Sentry already omits these unless sendDefaultPii is on; the beforeSend hook is what holds when it is (mutation
 * check: with sendDefaultPii on and the hook removed, this test fails).
 */
interface Received {
  path: string;
  body: string;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  return req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
};

/** Built at runtime so the value never appears in source (Sentry ships source context lines with stack frames). */
const SENTINEL = ['leak', 'probe', String(Date.now())].join('-');

describe('telemetry bootstrap delivers to a collector and to Sentry', () => {
  const received: Received[] = [];
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void readBody(req).then((body) => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = base;
    process.env['SENTRY_DSN'] = `http://publickey@127.0.0.1:${(server.address() as AddressInfo).port}/1`;
  });

  afterAll(async () => {
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['SENTRY_DSN'];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('exports a span and a counter over OTLP and an error to Sentry with request data stripped', async () => {
    startTelemetry({ service: 'bootstrap-test', env: 'test' });
    tracer().startActiveSpan('bootstrap-test.span', (span) => {
      span.setAttribute('oremedia.test', 'yes');
      span.end();
    });
    count(METRIC.policyDenials, 1, { reason: 'bootstrap_test' });
    captureException(new Error('bootstrap-test failure'), { journey: 'test' });
    // A request scope carrying data that must never leave the process.
    const Sentry = await import('@sentry/node');
    Sentry.withScope((scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: `https://api.example/v1/brands?token=${SENTINEL}`,
          query_string: `token=${SENTINEL}`,
          method: 'POST',
          headers: { authorization: `Bearer ${SENTINEL}`, cookie: `sid=${SENTINEL}` },
          cookies: { sid: SENTINEL },
          data: JSON.stringify({ password: SENTINEL }),
        },
      });
      Sentry.captureException(new Error('bootstrap-test request failure'));
    });
    // shutdown flushes the span processor and the periodic metric reader; flush drains Sentry's transport.
    await stopTelemetry();

    const traces = received.filter((r) => r.path === '/v1/traces');
    const metrics = received.filter((r) => r.path === '/v1/metrics');
    const sentry = received.filter((r) => r.path.startsWith('/api/1/'));
    expect(traces.map((t) => t.body).join('\n')).toContain('bootstrap-test.span');
    expect(metrics.map((m) => m.body).join('\n')).toContain(METRIC.policyDenials);
    const sentryBodies = sentry.map((s) => s.body).join('\n');
    expect(sentryBodies).toContain('bootstrap-test failure');
    expect(sentryBodies).toContain('bootstrap-test request failure');
    expect(sentryBodies).not.toContain(SENTINEL);
  }, 30_000);
});
