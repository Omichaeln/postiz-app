/**
 * Local top-of-hour burst (spec 17.4; ledger 7.2, the in-process half; tooling/load/top-of-hour.js is the k6 run
 * against a deployed API). Needs a MySQL 8 server only:
 *
 *   TEST_DATABASE_URL=mysql://root:oremedia@127.0.0.1:3306/mysql pnpm exec tsx tooling/load/local-burst.ts
 *
 * Builds four tenants in a throw-away database (one agency with a bulk schedule, three small tenants), prepares an
 * approved package per publication through the real modules, then fires every `publishing.publications.schedule`
 * call at once through the in-process API (same context builder as HTTP) for the SAME minute. The real outbox
 * dispatcher (fair per-tenant claim) starts each publication workflow into a simulated `core` worker with
 * CORE_CONCURRENCY slots (the worker's default), and the real publicationWorkflowV1 orchestration runs with the
 * fixture provider (a loopback platform). Reported per tenant: schedule latency, outbox dispatch delay (event
 * ready → workflow start) and dispatch lateness (claim − scheduled time, the spec 17.2 indicator), min and max.
 * Exits 1 when any tenant's max lateness exceeds 60 s or any schedule call failed.
 *
 * Environment: BURST_TOTAL (200), BULK_SHARE (0.7), CORE_CONCURRENCY (16), START_LATENCY_MS (2, a simulated
 * Temporal start round trip), BATCH_SIZE (100, the dispatch loop's default), LEAD_SECONDS (90).
 *
 * The preparation (`configureBurstWorld`, `openBurstLanes`, `prepareApproved`) and the whole run (`runLocalBurst`)
 * are exported for the CI-sized operational suite (apps/worker-core/src/operational.integration.test.ts), which
 * runs them against its own test database.
 */
import { pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { publications } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { defaultPolicyDocument, emptyBrandSystemDocument } from '../../packages/contracts/src/brand';
import type { ResolvedActor } from '../../packages/contracts/src/policy';
import type { PublicationWorkflowInputV1 } from '../../packages/contracts/src/publishing';
import {
  createPublishControlActivities,
  createPublishProviderActivities,
} from '../../packages/activities/src/index';
import { brandService } from '../../packages/modules/brand/src/index';
import { contentService } from '../../packages/modules/content/src/index';
import { dispatchBatch, type WorkflowStarter } from '../../packages/modules/operations/src/index';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  createPublishingRuntime,
  registerProviderClients,
  registerWorkflowProbe,
} from '../../packages/modules/publishing/src/index';
import { reviewService } from '../../packages/modules/review/src/index';
import { ProviderRegistry } from '../../packages/providers/src/index';
import { runPublication, type PublicationHost } from '../../packages/workflows/src/publication.workflow.v1';
import { composeModules } from '../../apps/worker-core/src/composition';
import { callPath, seedTwoTenants, type SeededTenant } from '../test-fixtures/src/seed';

export interface BurstOptions {
  total: number;
  bulkShare: number;
  coreConcurrency: number;
  startLatencyMs: number;
  batchSize: number;
  leadSeconds: number;
}

export const burstOptionsFromEnv = (): BurstOptions => ({
  total: Number(process.env['BURST_TOTAL'] ?? 200),
  bulkShare: Number(process.env['BULK_SHARE'] ?? 0.7),
  coreConcurrency: Number(process.env['CORE_CONCURRENCY'] ?? 16),
  startLatencyMs: Number(process.env['START_LATENCY_MS'] ?? 2),
  batchSize: Number(process.env['BATCH_SIZE'] ?? 100),
  leadSeconds: Number(process.env['LEAD_SECONDS'] ?? 90),
});

export interface Lane {
  tenant: SeededTenant;
  brandId: string;
  owner: ResolvedActor;
  connectionId: string;
  prepared: Array<{ channelVariantId: string; approvalId: string }>;
  scheduleMs: number[];
  errors: number;
  errorCodes: Record<string, number>;
  rateLimited: number;
  dispatchDelayMs: number[];
  latenessMs: number[];
  /** Publication states at the end of the run, by state. */
  states: Record<string, number>;
}

export interface BurstReport {
  at: Date;
  lanes: Lane[];
  worstLatenessMs: number;
  errors: number;
}

export const stats = (xs: number[]) =>
  xs.length
    ? {
        n: xs.length,
        min: Math.min(...xs),
        max: Math.max(...xs),
        p99: [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.99) - 1]!,
      }
    : { n: 0, min: 0, max: 0, p99: 0 };

const laneCtx = (t: SeededTenant): TenantContext => ({
  tenantId: t.tenantId,
  actor: { kind: 'user', id: t.ownerUserId },
  brandIds: 'all',
  correlationId: 'local-burst',
});

/** The worker-core half: the composition root, the fixture provider (a loopback platform) and the broker. */
export function configureBurstWorld(): FixtureProviderAdapter {
  composeModules();
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  registry.register(fixture);
  configurePublishingProviders({ registry, insecureAllowLoopback: true });
  configureCredentialBroker({ kms: new LocalKms('local-burst-master-secret-0123456789abcdef') });
  registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
  registerWorkflowProbe(null);
  return fixture;
}

/** Per tenant, on brand 2: a published brand version, an active policy and a connected fixture channel. */
export async function openBurstLanes(seeded: SeededTenant[]): Promise<Lane[]> {
  const lanes: Lane[] = [];
  for (const t of seeded) {
    const brandId = t.brandIds[1];
    const owner: ResolvedActor = {
      kind: 'user',
      id: t.ownerUserId,
      tenantId: t.tenantId,
      membershipId: t.ownerMembershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(laneCtx(t), () => withTransaction(fn));
    const draft = await run((tx) => brandService.versions.createDraft(owner, { brandId }, tx));
    await run((tx) =>
      brandService.versions.update(
        owner,
        { brandId, versionId: draft.versionId, expectedVersion: 0, document: emptyBrandSystemDocument() },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.submitForReview(
        owner,
        { brandId, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.publish(owner, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
    );
    const pv = await run((tx) =>
      brandService.policy.createVersion(owner, { brandId, document: defaultPolicyDocument() }, tx),
    );
    await run((tx) =>
      brandService.policy.activate(
        owner,
        { brandId, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );
    const started = await run((tx) =>
      channelService.connect.start(
        owner,
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    const connectionId = (
      await run((tx) => channelService.connect.complete(owner, { state: started.state, code: 'good' }, tx))
    ).id;
    lanes.push({
      tenant: t,
      brandId,
      owner,
      connectionId,
      prepared: [],
      scheduleMs: [],
      errors: 0,
      errorCodes: {},
      rateLimited: 0,
      dispatchDelayMs: [],
      latenessMs: [],
      states: {},
    });
  }
  return lanes;
}

/** `count` approved packages on the lane's channel (package → variant → review request → approval) for `at`. */
export async function prepareApproved(lane: Lane, count: number, at: Date, label: string): Promise<void> {
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(laneCtx(lane.tenant), () => withTransaction(fn));
  for (let n = 0; n < count; n++) {
    const pkg = await run((tx) =>
      contentService.packages.create(
        lane.owner,
        {
          brandId: lane.brandId,
          title: `burst ${n}`,
          copy: { schemaVersion: 1, master: { text: `Burst post ${label}-${n}`, factRefs: [] } },
          creativeDocumentIds: [],
        },
        tx,
      ),
    );
    const gen = await run((tx) =>
      contentService.variants.generate(
        lane.owner,
        { contentRevisionId: pkg.contentRevisionId, channelConnectionIds: [lane.connectionId] },
        tx,
      ),
    );
    const req = await run((tx) =>
      reviewService.requests.create(
        lane.owner,
        {
          contentRevisionId: pkg.contentRevisionId,
          assigneeUserIds: [],
          timing: { kind: 'exact', at: at.toISOString() },
        },
        tx,
      ),
    );
    const decided = await run((tx) =>
      reviewService.decisions.submit(
        lane.owner,
        {
          reviewRequestId: req.reviewRequestId,
          decision: 'approve',
          expectedManifestHash: req.manifestHash,
        },
        tx,
      ),
    );
    lane.prepared.push({ channelVariantId: gen.created[0]!, approvalId: decided.approvalId! });
  }
}

/** Every prepared variant of the lanes scheduled for `at` at once through the API's own request path. */
export async function fireSchedules(lanes: Lane[], at: Date): Promise<void> {
  const fired = lanes.flatMap((lane) =>
    lane.prepared.map(async (p) => {
      const t0 = performance.now();
      // A well-behaved client: RATE_LIMITED (spec 7.1 per-principal limit) is retried after retry-after.
      for (let attempt = 0; ; attempt++) {
        const res = await callPath(
          { bearer: lane.tenant.ownerToken, tenantId: lane.tenant.tenantId },
          'publishing.publications.schedule',
          {
            channelVariantId: p.channelVariantId,
            scheduledFor: at.toISOString(),
            authority: 'approval',
            approvalId: p.approvalId,
          },
        );
        if (res.error?.code === 'RATE_LIMITED' && attempt < 5) {
          lane.rateLimited += 1;
          await new Promise((r) => setTimeout(r, res.error?.retryAfterMs ?? 1000));
          continue;
        }
        lane.scheduleMs.push(performance.now() - t0);
        if (res.error) {
          lane.errors += 1;
          lane.errorCodes[res.error.code] = (lane.errorCodes[res.error.code] ?? 0) + 1;
        }
        break;
      }
    }),
  );
  await Promise.all(fired);
}

/** Measurements from the rows: outbox ready → dispatched per scheduling event, claim − scheduled time, end states. */
export async function measureLanes(tdb: TestDatabase, lanes: Lane[]): Promise<void> {
  for (const lane of lanes) {
    const events = await tdb.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, lane.tenant.tenantId),
          eq(outboxEvents.eventType, 'publication.scheduled'),
        ),
      );
    for (const e of events)
      if (e.dispatchedAt) lane.dispatchDelayMs.push(e.dispatchedAt.getTime() - e.availableAt.getTime());
    // The burst's own rows: the lane's brand (the seed leaves a scheduled publication on brand 1).
    const rows = await tdb.db
      .select()
      .from(publications)
      .where(and(eq(publications.tenantId, lane.tenant.tenantId), eq(publications.brandId, lane.brandId)));
    for (const r of rows)
      if (r.claimedAt) lane.latenessMs.push(r.claimedAt.getTime() - r.scheduledFor.getTime());
    lane.states = rows.reduce<Record<string, number>>(
      (m, r) => ({ ...m, [r.state]: (m[r.state] ?? 0) + 1 }),
      {},
    );
  }
}

/** The whole local burst against an already created test database (see the header). */
export async function runLocalBurst(tdb: TestDatabase, opts: BurstOptions): Promise<BurstReport> {
  const seeded = [await seedTwoTenants(tdb.db), await seedTwoTenants(tdb.db)].flatMap((s) => [
    s.tenantA,
    s.tenantB,
  ]);
  configureBurstWorld();
  const at = new Date(Math.ceil((Date.now() + opts.leadSeconds * 1000) / 1000) * 1000);
  const lanes = await openBurstLanes(seeded);

  // The bulk tenant schedules bulkShare of the burst; the rest is spread over the small tenants.
  const bulk = Math.round(opts.total * opts.bulkShare);
  const plan = lanes.map((_, i) => (i === 0 ? bulk : Math.floor((opts.total - bulk) / (lanes.length - 1))));
  plan[plan.length - 1]! += opts.total - plan.reduce((a, b) => a + b, 0);
  console.log(
    `preparing ${opts.total} approved packages for ${at.toISOString()} across ${lanes.length} tenants (${plan.join(' / ')})`,
  );
  for (const [i, lane] of lanes.entries()) await prepareApproved(lane, plan[i]!, at, String(i));
  if (Date.now() > at.getTime() - 5_000)
    throw new Error('preparation overran the lead time; raise LEAD_SECONDS');

  // worker-core runs alongside the API: the fair dispatcher starts workflows into a `core` worker with
  // coreConcurrency slots while the burst arrives.
  const runtime = createPublishingRuntime();
  const control = createPublishControlActivities(runtime.control);
  const provider = createPublishProviderActivities(runtime.provider);
  const queue: Array<() => Promise<void>> = [];
  let expected = opts.total;
  let burstDone = false;
  let wake: (() => void) | null = null;
  const starter: WorkflowStarter = {
    async start(req) {
      await new Promise((r) => setTimeout(r, opts.startLatencyMs));
      if (req.workflowType !== 'publicationWorkflowV1') return;
      const input = req.args[0] as PublicationWorkflowInputV1;
      const host: PublicationHost = {
        workflowId: req.workflowId,
        runId: `${req.workflowId}-run`,
        cancelRequested: () => false,
        takeRescheduled: () => false,
        now: () => Date.now(),
        waitForSignal: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1000))),
        sleep: (ms) => new Promise((r) => setTimeout(r, typeof ms === 'number' ? Math.min(ms, 1000) : 10)),
        providerActivities: () => ({ publish: provider, lookup: provider }),
      };
      queue.push(() => runPublication(control, input, host));
      wake?.();
    },
  };
  const dispatchLoop = (async () => {
    let idle = 0;
    while (!burstDone || idle < 3) {
      const s = await dispatchBatch({ workerId: 'local-burst', starter, batchSize: opts.batchSize });
      idle = s.claimed ? 0 : idle + 1;
      if (!s.claimed) await new Promise((r) => setTimeout(r, 200));
    }
  })();
  const workers = Array.from({ length: opts.coreConcurrency }, async () => {
    for (;;) {
      const task = queue.shift();
      if (task) {
        await task();
        expected -= 1;
        continue;
      }
      if (burstDone && expected <= 0) return;
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 100);
      });
    }
  });
  // The burst: every schedule call at once through the API's own request path.
  console.log('firing the schedule burst');
  await fireSchedules(lanes, at);
  expected -= lanes.reduce((n, l) => n + l.errors, 0);
  burstDone = true;
  await Promise.all([dispatchLoop, ...workers]);

  await measureLanes(tdb, lanes);
  return {
    at,
    lanes,
    worstLatenessMs: Math.max(...lanes.map((l) => stats(l.latenessMs).max)),
    errors: lanes.reduce((n, l) => n + l.errors, 0),
  };
}

async function main() {
  if (!process.env['TEST_DATABASE_URL']) throw new Error('TEST_DATABASE_URL is required (a MySQL 8 server)');
  const tdb = await createTestDatabase();
  try {
    const report = await runLocalBurst(tdb, burstOptionsFromEnv());
    for (const lane of report.lanes) {
      const sch = stats(lane.scheduleMs.map(Math.round));
      const late = stats(lane.latenessMs);
      const delay = stats(lane.dispatchDelayMs);
      console.log(
        `${lane === report.lanes[0] ? 'bulk ' : 'small'} ${lane.tenant.tenantId}: schedule n=${sch.n} max=${sch.max}ms ` +
          `p99=${sch.p99}ms errors=${lane.errors}${lane.errors ? JSON.stringify(lane.errorCodes) : ''} rate_limited_retries=${lane.rateLimited} | outbox delay min=${delay.min}ms max=${delay.max}ms | ` +
          `lateness min=${late.min}ms max=${late.max}ms p99=${late.p99}ms | ${JSON.stringify(lane.states)}`,
      );
    }
    console.log(
      `worst tenant max lateness ${report.worstLatenessMs} ms (SLO p99 < 60000 ms); schedule errors ${report.errors}`,
    );
    return report.worstLatenessMs <= 60_000 && report.errors === 0 ? 0 : 1;
  } finally {
    await tdb.drop();
  }
}

// Run as a script (tsx tooling/load/local-burst.ts); imported by the operational suite, it only exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
