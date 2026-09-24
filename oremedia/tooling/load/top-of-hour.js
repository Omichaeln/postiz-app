/* global __ENV, console */
/**
 * Top-of-hour publishing burst against a deployed Oremedia API (spec 17.4, 19.1; ledger 7.2). k6 script:
 *
 *   k6 run tooling/load/top-of-hour.js \
 *     -e BASE_URL=https://api.staging.oremedia.example \
 *     -e TENANTS='[{"tenantId":"ten_…","token":"ses_…","brandId":"brd_…","channelConnectionIds":["cc_…"]}]' \
 *     -e EXPECTED_PEAK=200 -e PEAK_MULTIPLIER=3
 *
 * Every tenant needs an owner (or publisher + reviewer) session token, a brand with a published brand version and
 * an active policy, and at least one certified channel connection (the fixture provider in staging, never a real
 * account). `setup()` prepares N = EXPECTED_PEAK × PEAK_MULTIPLIER approved variants spread across the M tenants
 * (package → variant → review request → approval; not measured). The measured scenario then fires every
 * `publishing.publications.schedule` call for the SAME minute (the next top of the hour, or TARGET_AT) as fast as
 * the VUs allow: the spike the spec asks for, not an average. `teardown()` waits until the minute has passed by
 * DISPATCH_WINDOW_S and counts, per tenant, the publications that reached a definitive state, so a bulk tenant
 * cannot hide another tenant's lateness.
 *
 * Thresholds: schedule p95 < 400 ms and p99 < 1 s (spec 17.2 edit-and-save budget, applied to the schedule
 * command), error rate < 1 %, and ≥ 99 % of the burst out of `scheduled` within the dispatch window (spec 17.2
 * dispatch lateness p99 < 60 s; the precise lateness is the server histogram oremedia.publish.dispatch_lateness_ms).
 * Never run this against production: it creates content and publishes to the configured connections.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const TENANTS = JSON.parse(__ENV.TENANTS || '[]');
const EXPECTED_PEAK = Number(__ENV.EXPECTED_PEAK || 100);
const PEAK_MULTIPLIER = Number(__ENV.PEAK_MULTIPLIER || 3);
const TOTAL = Math.max(1, Math.round(EXPECTED_PEAK * PEAK_MULTIPLIER));
const VUS = Number(__ENV.VUS || Math.min(TOTAL, 100));
const DISPATCH_WINDOW_S = Number(__ENV.DISPATCH_WINDOW_S || 120);

const scheduleLatency = new Trend('oremedia_schedule_latency', true);
const scheduleErrors = new Rate('oremedia_schedule_errors');
const outOfScheduled = new Rate('oremedia_dispatched_within_window');
const heldOrFailed = new Counter('oremedia_burst_not_published');

export const options = {
  setupTimeout: '30m',
  teardownTimeout: `${DISPATCH_WINDOW_S + 3600}s`,
  scenarios: {
    burst: { executor: 'shared-iterations', vus: VUS, iterations: TOTAL, maxDuration: '10m' },
  },
  thresholds: {
    oremedia_schedule_latency: ['p(95)<400', 'p(99)<1000'],
    oremedia_schedule_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
    oremedia_dispatched_within_window: ['rate>=0.99'],
  },
};

let seq = 0;
function call(tenant, path, input, kind) {
  seq += 1;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${tenant.token}`,
    'x-oremedia-tenant': tenant.tenantId,
    'x-correlation-id': `load-${kind}-${Date.now()}-${seq}`,
  };
  const isQuery = kind === 'query';
  if (!isQuery)
    headers['idempotency-key'] = `load-${Date.now()}-${Math.random().toString(36).slice(2)}-${seq}`;
  const url = `${BASE_URL}/trpc/${path}`;
  // superjson transformer: the input travels as { json: input }.
  const res = isQuery
    ? http.get(`${url}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, {
        headers,
        tags: { name: path },
      })
    : http.post(url, JSON.stringify({ json: input }), { headers, tags: { name: path } });
  let data = null;
  try {
    data = res.json('result.data.json');
  } catch {
    data = null;
  }
  return { res, data };
}

function nextTopOfHour() {
  if (__ENV.TARGET_AT) return new Date(__ENV.TARGET_AT);
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

export function setup() {
  if (!BASE_URL || TENANTS.length === 0) throw new Error('BASE_URL and TENANTS are required');
  const at = nextTopOfHour();
  const prepared = [];
  for (let i = 0; i < TOTAL; i++) {
    const tenant = TENANTS[i % TENANTS.length];
    const connection = tenant.channelConnectionIds[i % tenant.channelConnectionIds.length];
    const pkg = call(tenant, 'content.packages.create', {
      brandId: tenant.brandId,
      title: `load ${at.toISOString()} #${i}`,
      copy: {
        schemaVersion: 1,
        master: { text: `Load test post ${i} for ${at.toISOString()}`, factRefs: [] },
      },
      creativeDocumentIds: [],
    }).data;
    const gen = call(tenant, 'content.variants.generate', {
      contentRevisionId: pkg.contentRevisionId,
      channelConnectionIds: [connection],
    }).data;
    const req = call(tenant, 'review.requests.create', {
      contentRevisionId: pkg.contentRevisionId,
      assigneeUserIds: [],
      timing: { kind: 'exact', at: at.toISOString() },
    }).data;
    const decided = call(tenant, 'review.decisions.submit', {
      reviewRequestId: req.reviewRequestId,
      decision: 'approve',
      expectedManifestHash: req.manifestHash,
    }).data;
    prepared.push({
      tenantIndex: i % TENANTS.length,
      channelVariantId: gen.created[0],
      approvalId: decided.approvalId,
    });
  }
  return { at: at.toISOString(), prepared };
}

export default function burst(data) {
  const item = data.prepared[exec.scenario.iterationInTest];
  const tenant = TENANTS[item.tenantIndex];
  const { res, data: pub } = call(tenant, 'publishing.publications.schedule', {
    channelVariantId: item.channelVariantId,
    scheduledFor: data.at,
    authority: 'approval',
    approvalId: item.approvalId,
  });
  scheduleLatency.add(res.timings.duration, { tenant: tenant.tenantId });
  const ok = check(res, { 'schedule 200': (r) => r.status === 200 && pub && pub.state === 'scheduled' });
  scheduleErrors.add(!ok, { tenant: tenant.tenantId });
}

export function teardown(data) {
  const waitS = Math.max(0, (Date.parse(data.at) - Date.now()) / 1000) + DISPATCH_WINDOW_S;
  sleep(waitS);
  for (const tenant of TENANTS) {
    let cursor = null;
    const counts = {};
    do {
      const { data: page } = call(
        tenant,
        'publishing.publications.list',
        { brandId: tenant.brandId, page: cursor ? { limit: 100, cursor } : { limit: 100 } },
        'query',
      );
      if (!page) break;
      for (const p of page.items) {
        if (Date.parse(p.scheduledFor) !== Date.parse(data.at)) continue;
        counts[p.state] = (counts[p.state] || 0) + 1;
        outOfScheduled.add(p.state !== 'scheduled' && p.state !== 'dispatching', { tenant: tenant.tenantId });
        if (p.state !== 'published') heldOrFailed.add(1, { tenant: tenant.tenantId, state: p.state });
      }
      cursor = page.nextCursor;
    } while (cursor);
    console.log(`tenant ${tenant.tenantId}: ${JSON.stringify(counts)}`);
  }
}
