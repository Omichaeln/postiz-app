import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
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
  readonly docs = new Map<string, Doc>();
  readonly comments: Comment[] = [];
  readonly jobs = new Map<string, RenderJob>();
  readonly replays = new Map<string, unknown>();
  /** Test hooks: fail the next applyBatch with an INTERNAL envelope; fail the next render job. */
  failNextApply = false;
  failNextRender = false;
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];

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
      brandId: E2E.brandId,
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

interface Ctx {
  headers: IncomingHttpHeaders;
  correlationId: string;
}

const t = initTRPC.context<Ctx>().create({
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
const authed = t.middleware(({ ctx, next }) => {
  if (first(ctx.headers['authorization']) !== `Bearer ${E2E.token}`)
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next();
});
const tenantScoped = t.middleware(({ ctx, next }) => {
  const tenant = first(ctx.headers['x-oremedia-tenant']);
  if (!tenant) throw new TRPCError({ code: 'FORBIDDEN', message: 'Select a company first' });
  if (tenant !== E2E.tenantId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this company' });
  return next();
});

export function createMockRouter(backend: MockBackend) {
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
  const query = t.procedure.use(domainErrors).use(authed).use(tenantScoped);
  const mutation = query.use(idempotent);
  const authedOnly = t.procedure.use(domainErrors).use(authed);
  const brandDoc = fixtureSnapshot().document;
  const brandVersion = {
    id: E2E.brandVersionId,
    brandId: E2E.brandId,
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

  return t.router({
    access: t.router({
      listCompanies: authedOnly.query(() => [
        {
          tenantId: E2E.tenantId,
          name: E2E.companyName,
          slug: 'e2e',
          role: 'owner' as const,
          allBrands: true,
        },
      ]),
    }),
    brand: t.router({
      list: query.query(() => [
        {
          id: E2E.brandId,
          name: E2E.brandName,
          timezone: 'UTC',
          defaultLocale: 'en',
          status: 'active' as const,
          publishedVersionId: E2E.brandVersionId,
          version: 1,
        },
      ]),
      get: query.input(z.object({ brandId: z.string() })).query(({ input }) => {
        if (input.brandId !== E2E.brandId) throw new NotFoundError('Brand', input.brandId);
        return {
          id: E2E.brandId,
          name: E2E.brandName,
          timezone: 'UTC',
          defaultLocale: 'en',
          status: 'active' as const,
          publishedVersionId: E2E.brandVersionId,
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
              brandId: E2E.brandId,
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
          brandId: E2E.brandId,
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

/** A Node request handler mounted at /trpc by the static server. */
export function createMockHandler(backend: MockBackend) {
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
