import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, RequestListener } from 'node:http';
import { initTRPC, TRPCError } from '@trpc/server';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import superjson from 'superjson';
import { z } from 'zod';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import {
  CommentAdd,
  CommentList,
  CommentResolve,
  DocumentCreate,
  DocumentGet,
  OperationsApply,
  OperationsPropose,
  RenderGet,
  RenderRequest,
  RevisionGet,
  RevisionList,
  TemplateGet,
  TemplateList,
  type Operation,
  type OperationBatch,
} from '@oremedia/contracts/creative';
import { RunGet, RunSteps } from '@oremedia/contracts/agents';
import { AssetSearch, MediaSignedUrlRequest } from '@oremedia/contracts/assets';
import { BrandVersionGet, BrandVersionList, FactList, ObjectiveList } from '@oremedia/contracts/brand';
import {
  isOremediaError,
  NotFoundError,
  StaleRevisionError,
  toErrorEnvelope,
  ValidationFailedError,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';
import { applyBatch, changedElementIds, guardProtected, validateAgainstBrand } from '@oremedia/editor';
import { fixtureDocument, fixtureSnapshot, ids } from '@oremedia/editor/fixtures';
import { AuditQuery } from '@oremedia/contracts/operations';
import { PageRequest } from '@oremedia/contracts/pagination';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { Phase5Backend, phase5Routers, type ReviewerLink } from './mock-phase5';
import { deniedError, Phase6Backend, phase6Routers } from './mock-phase6';

/**
 * A UI-only transport for the studio smoke test: the same procedure paths, input DTOs, error envelope and header
 * contract as apps/api (bearer session, X-Oremedia-Tenant, Idempotency-Key with replay, STALE_REVISION on a stale
 * base), backed by an in-memory operation engine built from the real reducer and validator. It is a test double,
 * never a second implementation of the API.
 */
export const E2E = {
  token: 'ses_e2e_token',
  tenantId: 'ten_e2e',
  brandId: 'brd_e2e',
  brandVersionId: 'bv_e2e',
  companyName: 'E2E company',
  brandName: 'E2E brand',
};

/** A company as the mock serves it: one tenant with its brands; every row it holds carries these ids. */
export interface CompanyIdentity {
  tenantId: string;
  brandId: string;
  companyName: string;
  brandName: string;
}

/** The second company of the two-company suite (journey.e2e.test.ts): its own tenant, brand and stores. */
export const E2E_B: CompanyIdentity = {
  tenantId: 'ten_e2e_b',
  brandId: 'brd_e2e_b',
  companyName: 'Beta company',
  brandName: 'Beta brand',
};

/** A person's membership in one company (spec 5.1): role, and the brands granted (null = all brands). */
export interface MockMembership {
  role: MembershipRole;
  brandIds: string[] | null;
}
/** A signed-in person other than the default E2E session: bearer token → user and memberships by tenant. */
export interface MockSession {
  userId: string;
  memberships: Record<string, MockMembership>;
}
/** The resolved membership of the caller in the company a tenant-scoped procedure runs in. */
export interface MockMember extends MockMembership {
  userId: string;
}

interface BrandRow {
  id: string;
  name: string;
  publishedVersionId: string | null;
}

/** Agent runs as agents.runs.get returns them (the steps are served by agents.runs.steps). */
interface AgentRunRow {
  id: string;
  brandId: string;
  state: 'planned' | 'running' | 'waiting_for_review' | 'completed' | 'failed' | 'cancelled';
  taskKind: string;
  autonomyMode: 'assist' | 'create' | 'prepare_release' | 'managed_autopublish';
  servicePrincipalId: string;
  initiatorKind: 'user' | 'system' | 'recommendation';
  initiatorId: string;
  brief: Record<string, unknown>;
  contextSnapshotHash: string | null;
  skillVersionIds: string[];
  modelConfig: Record<string, string>;
  budgetReservationId: string | null;
  costMicros: number;
  deadlineAt: string;
  workflowId: string;
  correlationId: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  steps: Array<{
    id: string;
    index: number;
    kind: 'plan' | 'model_call' | 'tool_call' | 'validation';
    summary: string;
    tokensIn: number;
    tokensOut: number;
    costMicros: number;
    durationMs: number;
    createdAt: string;
    invocations: never[];
  }>;
}

interface Rev {
  id: string;
  documentId: string;
  parentRevisionId: string | null;
  number: number;
  brandVersionId: string;
  agentRunId: string | null;
  authorKind: 'user' | 'agent';
  authorId: string;
  changeSummary: string;
  operations: OperationBatch;
  snapshot: CreativeDocumentV1;
  contentHash: string;
  createdAt: string;
}
interface Doc {
  id: string;
  brandId: string;
  contentPackageId: null;
  title: string;
  currentRevisionId: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  version: number;
  revisions: Rev[];
}
interface Comment {
  id: string;
  documentId: string;
  revisionId: string;
  elementId: string;
  body: string;
  authorKind: 'user';
  authorId: string;
  state: 'open' | 'resolved' | 'outdated';
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface RenderJob {
  id: string;
  revisionId: string;
  formatKeys: string[];
  state: 'pending' | 'rendering' | 'ready' | 'failed';
  attempts: number;
  error: string | null;
  requestedByKind: 'user';
  requestedById: string;
  exportIds: string[];
  exports: never[];
  createdAt: string;
  updatedAt: string;
  version: number;
  polls: number;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

export class MockBackend {
  readonly tenantId: string;
  readonly brandId: string;
  readonly companyName: string;
  readonly brandName: string;
  /** Phase 5: calendar, publications, channels, review requests and reviewer links (mock-phase5.ts). */
  readonly phase5: Phase5Backend;
  /** Phase 6: intelligence, experiments, campaigns, briefs, packages and channel connections (mock-phase6.ts). */
  readonly phase6: Phase6Backend;
  /** The company's brands (brand.list / brand.get); the first is the brand every seeded row belongs to. */
  readonly brands: BrandRow[];
  /** Agent runs of this company (agents.runs.*, listed through operations.audit.query). */
  readonly runs = new Map<string, AgentRunRow>();
  /** The signed-in person's role in the company (access.listCompanies); the server still decides every call. */
  role: MembershipRole = 'owner';
  /**
   * Other people who can sign in (bearer token → session), shared by every company of the group so one person can
   * belong to several. The default `E2E.token` session stays the single-company owner the other suites use.
   */
  sessions = new Map<string, MockSession>();
  /** The other companies served next to this one; requests are routed by their X-Oremedia-Tenant header. */
  readonly companies: MockBackend[] = [];
  /** Procedure paths the policy engine refuses for this person (FORBIDDEN envelope), e.g. `publishing.channels.list`. */
  readonly denied = new Set<string>();
  /** Procedure paths whose next N calls fail with an INTERNAL envelope, to exercise error states and retries. */
  readonly failNext = new Map<string, number>();
  /** Procedure paths answered after a delay (ms), to observe loading states. */
  readonly delays = new Map<string, number>();
  readonly docs = new Map<string, Doc>();
  readonly comments: Comment[] = [];
  readonly jobs = new Map<string, RenderJob>();
  readonly replays = new Map<string, unknown>();
  /** Test hooks: fail the next applyBatch with an INTERNAL envelope; fail the next render job. */
  failNextApply = false;
  failNextRender = false;
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];

  /** `seed: false` starts the company empty apart from its brand (a second company seeds its own few rows). */
  constructor(company: CompanyIdentity = E2E, seed = true) {
    this.tenantId = company.tenantId;
    this.brandId = company.brandId;
    this.companyName = company.companyName;
    this.brandName = company.brandName;
    this.phase5 = new Phase5Backend(company.tenantId, company.brandId, seed);
    this.phase6 = new Phase6Backend(this.phase5, seed);
    this.brands = [{ id: company.brandId, name: company.brandName, publishedVersionId: E2E.brandVersionId }];
    if (seed) this.addRun('run_e2e_copy', 'copywriting', 'completed', 9_990);
  }

  /** Serves `other` next to this company for the same people (one sign-in, two tenants, spec 5.1). */
  addCompany(other: MockBackend): void {
    other.sessions = this.sessions;
    this.companies.push(other);
  }

  /** A further brand in this company (a creator's grant can leave it out). */
  addBrand(id: string, name: string): void {
    this.brands.push({ id, name, publishedVersionId: E2E.brandVersionId });
  }

  /** A finished agent run of this company's brand, as the audit log and agents.runs.get report it. */
  addRun(id: string, taskKind: string, state: AgentRunRow['state'], costMicros: number): AgentRunRow {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const run: AgentRunRow = {
      id,
      brandId: this.brandId,
      state,
      taskKind,
      autonomyMode: 'create',
      servicePrincipalId: 'sp_e2e_agent',
      initiatorKind: 'user',
      initiatorId: 'usr_e2e',
      brief: { goal: taskKind },
      contextSnapshotHash: null,
      skillVersionIds: [],
      modelConfig: { provider: 'anthropic', model: 'model-e2e' },
      budgetReservationId: null,
      costMicros,
      deadlineAt: at(-30),
      workflowId: `run:${id}`,
      correlationId: `corr_${id}`,
      finishedAt: ['planned', 'running', 'waiting_for_review'].includes(state) ? null : at(1),
      createdAt: at(10),
      updatedAt: at(1),
      version: 1,
      steps: [
        {
          id: `st_${id}`,
          index: 0,
          kind: 'model_call',
          summary: 'final (end_turn): done',
          tokensIn: 900,
          tokensOut: 200,
          costMicros,
          durationMs: 1_200,
          createdAt: at(5),
          invocations: [],
        },
      ],
    };
    this.runs.set(id, run);
    return run;
  }

  /** The caller's membership in this company, or null when the bearer is not a member of it. */
  memberFor(bearer: string | undefined): MockMember | null {
    if (bearer === `Bearer ${E2E.token}`)
      return this.tenantId === E2E.tenantId ? { userId: 'usr_e2e', role: this.role, brandIds: null } : null;
    const session = bearer?.startsWith('Bearer ') ? this.sessions.get(bearer.slice(7)) : undefined;
    const membership = session?.memberships[this.tenantId];
    return session && membership ? { userId: session.userId, ...membership } : null;
  }

  createDocument(title: string, snapshot = fixtureDocument()): Doc {
    const id = rid('doc');
    const revision = this.revision(
      id,
      null,
      1,
      {
        baseRevisionId: '',
        operations: snapshot.pages.map((page, index) => ({ op: 'addPage', page, index })),
        summary: 'Initial document',
        origin: 'user',
      },
      snapshot,
    );
    const doc: Doc = {
      id,
      brandId: this.brandId,
      contentPackageId: null,
      title,
      currentRevisionId: revision.id,
      schemaVersion: 1,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
      revisions: [revision],
    };
    this.docs.set(id, doc);
    return doc;
  }

  private revision(
    documentId: string,
    parent: Rev | null,
    number: number,
    batch: OperationBatch,
    snapshot: CreativeDocumentV1,
  ): Rev {
    return {
      id: rid('rev'),
      documentId,
      parentRevisionId: parent?.id ?? null,
      number,
      brandVersionId: E2E.brandVersionId,
      agentRunId: batch.agentRunId ?? null,
      authorKind: batch.origin,
      authorId: 'usr_e2e',
      changeSummary: batch.summary,
      operations: batch,
      snapshot,
      contentHash: hash(snapshot),
      createdAt: now(),
    };
  }

  doc(documentId: string): Doc {
    const doc = this.docs.get(documentId);
    if (!doc) throw new NotFoundError('CreativeDocument', documentId);
    return doc;
  }

  head(documentId: string): Rev {
    const doc = this.doc(documentId);
    return doc.revisions.find((r) => r.id === doc.currentRevisionId) as Rev;
  }

  /** Spec 11.4 applyOperations, in memory: stale check, guards, reduce, validate, new revision, comment outdating. */
  apply(input: z.infer<typeof OperationsApply>) {
    const { documentId, ...batch } = input;
    const doc = this.doc(documentId);
    if (doc.currentRevisionId !== batch.baseRevisionId) throw new StaleRevisionError(doc.currentRevisionId);
    const base = this.head(documentId);
    const evaluated = this.evaluate(base, batch);
    const revision = this.revision(documentId, base, base.number + 1, batch, evaluated.snapshot);
    doc.revisions.push(revision);
    doc.currentRevisionId = revision.id;
    doc.version += 1;
    doc.updatedAt = now();
    const changed = new Set(changedElementIds(batch));
    let outdated = 0;
    for (const c of this.comments)
      if (c.documentId === documentId && c.state === 'open' && changed.has(c.elementId)) {
        c.state = 'outdated';
        c.version += 1;
        outdated += 1;
      }
    return { revision, findings: evaluated.findings, outdatedComments: outdated, version: doc.version };
  }

  evaluate(base: Rev, batch: Omit<OperationBatch, 'baseRevisionId'> & { baseRevisionId?: string }) {
    let next = base.snapshot;
    batch.operations.forEach((op, index) => {
      guardProtected(next, op, batch.origin);
      try {
        next = applyBatch(next, { operations: [op] });
      } catch (err) {
        throw new ValidationFailedError([
          { path: `operations.${index}`, issue: err instanceof Error ? err.message : String(err) },
        ]);
      }
    });
    const findings = validateAgainstBrand(next, fixtureSnapshot());
    return {
      snapshot: next,
      findings,
      contentHash: hash(next),
      changedElementIds: changedElementIds(batch),
      blocking: findings.some((f) => f.severity === 'blocking'),
    };
  }

  /** Test backdoor: another actor commits on the head (what makes the UI's next save stale). */
  applyOutOfBand(documentId: string, operations: Operation[], summary = 'Out-of-band edit'): Rev {
    return this.apply({
      documentId,
      baseRevisionId: this.head(documentId).id,
      operations,
      summary,
      origin: 'user',
    }).revision;
  }
}

/**
 * Company B of the two-company suite: its own tenant, brand and stores, seeded with a few rows of its own (a channel,
 * a campaign, an agent run) and none of company A's, so any row of A that appears while B is selected is a leak.
 */
export function createSecondCompany(): MockBackend {
  const b = new MockBackend(E2E_B, false);
  b.phase5.addChannel(
    'cc_beta_linkedin',
    'linkedin',
    'Beta LinkedIn',
    'active',
    new Date(Date.now() + 30 * 86_400_000).toISOString(),
  );
  b.phase6.addCampaign('cmp_beta_harvest', 'Beta harvest', -2, 20);
  b.addRun('run_beta_layout', 'layout', 'completed', 4_200);
  return b;
}

interface Ctx {
  headers: IncomingHttpHeaders;
  correlationId: string;
  /** Set when the bearer was an external reviewer link token (`rl_…`), spec 5.6. */
  reviewer?: ReviewerLink | null;
  /** Set for a member session once the company is resolved (tenant-scoped procedures). */
  member?: MockMember | null;
}

export const t = initTRPC.context<Ctx>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error, ctx }) => {
    const correlationId = ctx?.correlationId ?? 'unknown';
    let envelope: ErrorEnvelope;
    if (isOremediaError(error.cause)) envelope = toErrorEnvelope(error.cause, correlationId);
    else if (error.code === 'UNAUTHORIZED')
      envelope = { code: 'UNAUTHENTICATED', message: 'Authentication required', correlationId };
    else if (error.code === 'FORBIDDEN')
      envelope = {
        code: 'FORBIDDEN',
        message: error.message || 'You are not allowed to perform this action',
        correlationId,
      };
    else if (error.code === 'BAD_REQUEST')
      envelope = {
        code: 'VALIDATION_FAILED',
        message:
          error.message === 'IDEMPOTENCY_KEY_REQUIRED' ? 'Idempotency-Key header is required' : 'Bad request',
        correlationId,
      };
    else envelope = { code: 'INTERNAL', message: 'Something went wrong', correlationId };
    return { ...shape, message: envelope.message, data: { ...shape.data, envelope } };
  },
});

const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);

const domainErrors = t.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (isOremediaError(err))
      throw new TRPCError({
        code:
          err.code === 'STALE_REVISION' || err.code === 'CONFLICT'
            ? 'CONFLICT'
            : err.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : err.code === 'FORBIDDEN'
                ? 'FORBIDDEN'
                : err.code === 'VALIDATION_FAILED'
                  ? 'BAD_REQUEST'
                  : 'INTERNAL_SERVER_ERROR',
        message: err.message,
        cause: err,
      });
    throw err;
  }
});
/**
 * The shared middlewares as apps/api applies them: bearer authentication (a session token, or an `rl_…` reviewer
 * link token that resolves to a stored link), tenant scoping from the X-Oremedia-Tenant header against the caller's
 * memberships (an external reviewer is bound to its link's tenant and sends none), the brand grant of a member
 * restricted to some brands (any other brand id is NOT_FOUND, spec 5.4: never reveal it exists), and
 * Idempotency-Key replay on every mutation.
 */
export function createBuilders(backend: MockBackend) {
  const authed = t.middleware(({ ctx, next }) => {
    const bearer = first(ctx.headers['authorization']);
    let reviewer: ReviewerLink | null = null;
    const session = bearer?.startsWith('Bearer ') && backend.sessions.has(bearer.slice(7));
    if (bearer !== `Bearer ${E2E.token}` && !session) {
      reviewer = bearer?.startsWith('Bearer rl_') ? backend.phase5.linkByToken(bearer.slice(7)) : null;
      if (!reviewer) throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    return next({ ctx: { ...ctx, reviewer } });
  });
  const tenantScoped = t.middleware(({ ctx, next }) => {
    if (ctx.reviewer) return next();
    const tenant = first(ctx.headers['x-oremedia-tenant']);
    if (!tenant) throw new TRPCError({ code: 'FORBIDDEN', message: 'Select a company first' });
    const member =
      tenant === backend.tenantId ? backend.memberFor(first(ctx.headers['authorization'])) : null;
    if (!member) throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this company' });
    return next({ ctx: { ...ctx, member } });
  });
  const policy = t.middleware(async ({ ctx, path, getRawInput, next }) => {
    const delay = backend.delays.get(path);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (backend.denied.has(path)) throw deniedError(path);
    const raw = (await getRawInput()) as { brandId?: unknown } | undefined;
    const grants = ctx.member?.brandIds ?? null;
    if (grants && typeof raw?.brandId === 'string' && !grants.includes(raw.brandId))
      throw new NotFoundError('Brand', raw.brandId);
    const failures = backend.failNext.get(path) ?? 0;
    if (failures > 0) {
      if (failures === 1) backend.failNext.delete(path);
      else backend.failNext.set(path, failures - 1);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'simulated outage' });
    }
    return next();
  });
  const idempotent = t.middleware(async ({ ctx, path, next }) => {
    const key = first(ctx.headers['idempotency-key']);
    if (!key) throw new TRPCError({ code: 'BAD_REQUEST', message: 'IDEMPOTENCY_KEY_REQUIRED' });
    const replayKey = `${path}:${key}`;
    if (backend.replays.has(replayKey))
      return {
        ok: true as const,
        data: backend.replays.get(replayKey),
        ctx,
        marker: 'replay' as const,
      } as never;
    const result = await next();
    if (result.ok) backend.replays.set(replayKey, result.data);
    return result;
  });
  const query = t.procedure.use(domainErrors).use(authed).use(tenantScoped).use(policy);
  const mutation = query.use(idempotent);
  const authedOnly = t.procedure.use(domainErrors).use(authed);
  return { query, mutation, authedOnly };
}
export type MockBuilders = ReturnType<typeof createBuilders>;

export function createMockRouter(backend: MockBackend) {
  const { query, mutation, authedOnly } = createBuilders(backend);
  const brandDoc = fixtureSnapshot().document;
  const brandVersion = {
    id: E2E.brandVersionId,
    brandId: backend.brandId,
    number: 1,
    state: 'published' as const,
    document: brandDoc,
    contentHash: hash(brandDoc),
    publishedAt: now(),
    publishedByUserId: 'usr_e2e',
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  };
  const { document: _d, ...brandVersionSummary } = brandVersion;
  const pngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2NkYPj/n4GBgYGJgYEBAAgQAgHfTMWQAAAAAElFTkSuQmCC';

  const p6 = phase6Routers(backend.phase6, { router: t.router, query, mutation });
  const p5 = phase5Routers(
    backend.phase5,
    { router: t.router, query, mutation },
    { variants: p6.variants, channels: p6.channels },
  );

  return t.router({
    content: t.mergeRouters(p5.content, p6.content),
    publishing: p5.publishing,
    review: p5.review,
    intelligence: p6.intelligence,
    experiments: p6.experiments,
    access: t.router({
      listCompanies: authedOnly.query(({ ctx }) => {
        const bearer = first(ctx.headers['authorization']);
        // Every company of the group the caller belongs to, with the role and brand scope of that membership.
        return [backend, ...backend.companies].flatMap((company) => {
          const member = company.memberFor(bearer);
          return member
            ? [
                {
                  tenantId: company.tenantId,
                  name: company.companyName,
                  slug: company.tenantId.replace(/^ten_/, ''),
                  role: member.role,
                  allBrands: member.brandIds === null,
                },
              ]
            : [];
        });
      }),
    }),
    agents: t.router({
      runs: t.router({
        get: query.input(RunGet).query(({ input }) => {
          const run = backend.runs.get(input.runId);
          if (!run) throw new NotFoundError('AgentRun', input.runId);
          const { steps: _s, ...dto } = run;
          return dto;
        }),
        steps: query.input(RunSteps).query(({ input }) => {
          const run = backend.runs.get(input.runId);
          if (!run) throw new NotFoundError('AgentRun', input.runId);
          return { items: run.steps, nextCursor: null };
        }),
      }),
    }),
    operations: t.router({
      audit: t.router({
        /** The run history the agents screen reads: one `agent.run.request` event per run of this company. */
        query: query.input(z.object({ query: AuditQuery, page: PageRequest })).query(({ input }) => ({
          items: [...backend.runs.values()]
            .filter(() => input.query.resourceType === undefined || input.query.resourceType === 'agent_run')
            .map((r, i) => ({
              id: `aud_${String(1000 - i).padStart(4, '0')}`,
              tenantId: backend.tenantId,
              actorKind: 'user',
              actorId: r.initiatorId,
              supportSessionId: null,
              action: 'agent.run.request',
              resourceType: 'agent_run',
              resourceId: r.id,
              decision: 'allowed' as const,
              reason: null,
              correlationId: r.correlationId,
              metadata: { brandId: r.brandId, runId: r.id, toState: 'planned' },
              createdAt: new Date(r.createdAt),
            })),
          nextCursor: null,
        })),
      }),
    }),
    brand: t.router({
      list: query.query(({ ctx }) =>
        backend.brands
          .filter((b) => !ctx.member?.brandIds || ctx.member.brandIds.includes(b.id))
          .map((b) => ({
            id: b.id,
            name: b.name,
            timezone: 'UTC',
            defaultLocale: 'en',
            status: 'active' as const,
            publishedVersionId: b.publishedVersionId,
            version: 1,
          })),
      ),
      get: query.input(z.object({ brandId: z.string() })).query(({ input }) => {
        const b = backend.brands.find((x) => x.id === input.brandId);
        if (!b) throw new NotFoundError('Brand', input.brandId);
        return {
          id: b.id,
          name: b.name,
          timezone: 'UTC',
          defaultLocale: 'en',
          status: 'active' as const,
          publishedVersionId: b.publishedVersionId,
          activePolicyVersionId: null,
          version: 1,
        };
      }),
      versions: t.router({
        list: query.input(BrandVersionList).query(() => ({ items: [brandVersionSummary], nextCursor: null })),
        get: query.input(BrandVersionGet).query(() => brandVersion),
      }),
      facts: t.router({ list: query.input(FactList).query(() => ({ items: [], nextCursor: null })) }),
      objectives: t.router({
        list: query.input(ObjectiveList).query(() => ({ items: [], nextCursor: null })),
      }),
    }),
    assets: t.router({
      search: query.input(AssetSearch).query(() => ({
        items: [
          {
            assetId: 'ast_e2e',
            assetVersionId: 'av_photo',
            kind: 'photo' as const,
            semanticRole: null,
            altText: 'Sample photo',
            contentHash: hash('photo'),
            width: 2,
            height: 2,
          },
        ],
        nextCursor: null,
      })),
      media: t.router({
        signedUrl: query.input(MediaSignedUrlRequest).query(({ input }) => {
          if (input.assetVersionId !== 'av_photo')
            throw new NotFoundError('AssetVersion', input.assetVersionId);
          return { url: pngDataUrl, expiresAt: new Date(Date.now() + 300_000), mime: 'image/png' };
        }),
      }),
    }),
    creative: t.router({
      documents: t.router({
        create: mutation.input(DocumentCreate).mutation(({ input }) => {
          const doc = backend.createDocument(input.title, input.document);
          const head = backend.head(doc.id);
          return {
            documentId: doc.id,
            revisionId: head.id,
            number: 1,
            version: 1,
            contentHash: head.contentHash,
            findings: [],
          };
        }),
        get: query.input(DocumentGet).query(({ input }) => {
          const { revisions: _r, ...doc } = backend.doc(input.documentId);
          return { ...doc, revision: backend.head(input.documentId) };
        }),
      }),
      revisions: t.router({
        list: query.input(RevisionList).query(({ input }) => ({
          items: backend
            .doc(input.documentId)
            .revisions.slice()
            .reverse()
            .map(({ operations: _o, snapshot: _s, ...summary }) => summary),
          nextCursor: null,
        })),
        get: query.input(RevisionGet).query(({ input }) => {
          const rev = backend.doc(input.documentId).revisions.find((r) => r.id === input.revisionId);
          if (!rev) throw new NotFoundError('CreativeRevision', input.revisionId);
          return rev;
        }),
      }),
      operations: t.router({
        applyBatch: mutation.input(OperationsApply).mutation(({ input }) => {
          if (backend.failNextApply) {
            backend.failNextApply = false;
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'simulated outage' });
          }
          return backend.apply(input);
        }),
        propose: mutation.input(OperationsPropose).mutation(({ input }) => {
          const { documentId, ...batch } = input;
          const doc = backend.doc(documentId);
          if (doc.currentRevisionId !== batch.baseRevisionId)
            throw new StaleRevisionError(doc.currentRevisionId);
          const base = backend.head(documentId);
          const e = backend.evaluate(base, batch);
          return {
            baseRevisionId: base.id,
            snapshot: e.snapshot,
            contentHash: e.contentHash,
            findings: e.findings,
            changedElementIds: e.changedElementIds,
            blocking: e.blocking,
            preview: {
              kind: 'scene' as const,
              rendererVersion: '1.0.0',
              publishable: false as const,
              pages: [],
            },
          };
        }),
      }),
      renders: t.router({
        request: mutation.input(RenderRequest).mutation(({ input }) => {
          const id = rid('rj');
          backend.jobs.set(id, {
            id,
            revisionId: input.revisionId,
            formatKeys: input.formatKeys,
            state: 'pending',
            attempts: 0,
            error: null,
            requestedByKind: 'user',
            requestedById: 'usr_e2e',
            exportIds: [],
            exports: [],
            createdAt: now(),
            updatedAt: now(),
            version: 0,
            polls: 0,
          });
          return { renderJobId: id, state: 'pending' as const, version: 0 };
        }),
        get: query.input(RenderGet).query(({ input }) => {
          const job = backend.jobs.get(input.renderJobId);
          if (!job) throw new NotFoundError('RenderJob', input.renderJobId);
          job.polls += 1;
          // No render worker in a UI-only smoke: the job fails on the second poll when asked to, else stays queued.
          if (backend.failNextRender && job.polls >= 2) {
            backend.failNextRender = false;
            job.state = 'failed';
            job.error = 'Renderer exited: font asset av_font could not be loaded';
          }
          const { polls: _p, ...dto } = job;
          return dto;
        }),
      }),
      comments: t.router({
        add: mutation.input(CommentAdd).mutation(({ input }) => {
          backend.doc(input.documentId);
          const c: Comment = {
            id: rid('cmt'),
            documentId: input.documentId,
            revisionId: input.revisionId,
            elementId: input.elementId,
            body: input.body,
            authorKind: 'user',
            authorId: 'usr_e2e',
            state: 'open',
            createdAt: now(),
            updatedAt: now(),
            version: 0,
          };
          backend.comments.push(c);
          return { commentId: c.id, state: 'open' as const, version: 0 };
        }),
        resolve: mutation.input(CommentResolve).mutation(({ input }) => {
          const c = backend.comments.find((x) => x.id === input.commentId);
          if (!c) throw new NotFoundError('ElementComment', input.commentId);
          c.state = 'resolved';
          c.version += 1;
          return { commentId: c.id, state: 'resolved' as const, version: c.version };
        }),
        list: query.input(CommentList).query(({ input }) => ({
          items: backend.comments.filter((c) => c.documentId === input.documentId),
          nextCursor: null,
        })),
      }),
      templates: t.router({
        list: query.input(TemplateList).query(() => ({
          items: [
            {
              id: 'tpl_e2e',
              brandId: backend.brandId,
              name: 'Promo template',
              currentVersionId: 'tv_e2e',
              state: 'active' as const,
              createdAt: now(),
              updatedAt: now(),
              version: 1,
            },
          ],
          nextCursor: null,
        })),
        get: query.input(TemplateGet).query(() => ({
          id: 'tpl_e2e',
          brandId: backend.brandId,
          name: 'Promo template',
          currentVersionId: 'tv_e2e',
          state: 'active' as const,
          createdAt: now(),
          updatedAt: now(),
          version: 1,
          versions: [],
          selectedVersion: {
            id: 'tv_e2e',
            templateId: 'tpl_e2e',
            number: 1,
            slots: [{ key: 'headline', elementId: ids.headline, kind: 'text', required: true }],
            constraints: {},
            formats: ['square_1080'],
            document: fixtureDocument(),
            contentHash: hash('tv'),
            state: 'approved' as const,
            createdAt: now(),
          },
        })),
      }),
    }),
  });
}

export type MockRouter = ReturnType<typeof createMockRouter>;

/** One company's handler: its router over its own stores, logging every request it serves. */
function companyHandler(backend: MockBackend) {
  return createHTTPHandler({
    router: createMockRouter(backend),
    basePath: '/trpc/',
    createContext: ({ req }) => {
      const path = (req.url ?? '').replace(/^\/trpc\//, '').split('?')[0] ?? '';
      backend.requests.push({ path, headers: req.headers });
      return { headers: req.headers, correlationId: first(req.headers['x-correlation-id']) ?? randomUUID() };
    },
  });
}

/**
 * A Node request handler mounted at /trpc by the static server. With several companies (`addCompany`) a request goes
 * to the company its X-Oremedia-Tenant header names, so each tenant's reads and writes only ever reach its own
 * stores; requests without a tenant (listCompanies, the review portal) and unknown tenants go to the first company,
 * which answers them or refuses the tenant as apps/api does.
 */
export function createMockHandler(backend: MockBackend): RequestListener {
  const handlers = new Map<string, RequestListener>(
    [backend, ...backend.companies].map((company) => [company.tenantId, companyHandler(company)]),
  );
  const primary = handlers.get(backend.tenantId) as RequestListener;
  return (req, res) => (handlers.get(first(req.headers['x-oremedia-tenant']) ?? '') ?? primary)(req, res);
}
