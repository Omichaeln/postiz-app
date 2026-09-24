import { z } from 'zod';
import {
  CommentAdd,
  CommentList,
  CommentResolve,
  CreativeDocumentV1,
  DocumentCreate,
  DocumentGet,
  OperationBatch,
  OperationsApply,
  OperationsPropose,
  RenderGet,
  RenderManifest,
  RenderMarkFailed,
  RenderMarkReady,
  RenderMarkRendering,
  RenderRequest,
  RenderValidationResult,
  RevisionGet,
  RevisionList,
  TemplateApprove,
  TemplateCreate,
  TemplateGet,
  TemplateList,
  TemplateSlot,
  TemplateVersionCreate,
  type Element,
  type Finding,
  type Operation,
} from '@oremedia/contracts/creative';
import {
  NotFoundError,
  PolicyDeniedError,
  StaleRevisionError,
  ValidationFailedError,
  type ErrorDetail,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { renderJobMachine } from '@oremedia/domain/state-machines/render-job';
import { templateMachine, templateVersionMachine } from '@oremedia/domain/state-machines/template-version';
import { FORMAT_DEFINITIONS } from '@oremedia/editor/formats';
import { guardLogoInsertion, guardProtected } from '@oremedia/editor/guard';
import {
  OperationError,
  allElementIds,
  changedElementIds,
  findElement,
  reduce,
  type TemplateDocument,
} from '@oremedia/editor/reduce';
import { validateAgainstBrand } from '@oremedia/editor/validate';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { audit, outbox } from '@oremedia/module-operations';
import {
  CreativeDocumentRepository,
  CreativeRevisionRepository,
  ElementCommentRepository,
  RenderJobRepository,
  RenderedExportRepository,
  TemplateRepository,
  TemplateVersionRepository,
} from './repositories';

const documentsRepo = new CreativeDocumentRepository();
const revisionsRepo = new CreativeRevisionRepository();
const renderJobsRepo = new RenderJobRepository();
const exportsRepo = new RenderedExportRepository();
const commentsRepo = new ElementCommentRepository();
const templatesRepo = new TemplateRepository();
const templateVersionsRepo = new TemplateVersionRepository();

type DocumentRow = Awaited<ReturnType<typeof documentsRepo.getById>>;
type RevisionRow = Awaited<ReturnType<typeof revisionsRepo.getById>>;
type RenderJobRow = Awaited<ReturnType<typeof renderJobsRepo.getById>>;
type ExportRow = Awaited<ReturnType<typeof exportsRepo.getById>>;
type CommentRow = Awaited<ReturnType<typeof commentsRepo.getById>>;
type TemplateRow = Awaited<ReturnType<typeof templatesRepo.getById>>;
type TemplateVersionRow = Awaited<ReturnType<typeof templateVersionsRepo.getById>>;

/**
 * Policy options the caller may pass through (spec 5.5 step 7): the agent runtime supplies the run's autonomy
 * mode; the router passes nothing, so an agent editing through the API is held to `assist` and denied.
 */
export interface ActorOptions {
  autonomyMode?: AutonomyMode;
}

// ---- cross-module hooks (same pattern as registerBrandChecker: modules never import each other's tables) ----

/** Spec 11.4 guardAssets: assets.authoriseUse for every referenced asset version; the assets module registers it. */
/** Purposes the studio authorises: image/logo/background layers as `creative`, text fonts as `font` (spec 9.2). */
export type CreativeAssetPurpose = 'creative' | 'font';
export type AssetAuthoriser = (
  assetVersionId: string,
  ctx: { tenantId: string; brandId: string; purpose: CreativeAssetPurpose },
  tx: Tx,
) => Promise<void>;
export interface AssetRef {
  assetVersionId: string;
  purpose: CreativeAssetPurpose;
}
const unregisteredAuthoriser: AssetAuthoriser = async () => {
  throw new Error('asset authoriser not registered (composition root must call registerAssetAuthoriser)');
};
let assetAuthoriser: AssetAuthoriser = unregisteredAuthoriser;
/** Test seam: back to the loud default. */
export const resetAssetAuthoriser = (): void => {
  assetAuthoriser = unregisteredAuthoriser;
};
export const registerAssetAuthoriser = (fn: AssetAuthoriser): void => {
  assetAuthoriser = fn;
};

/** Spec 11.4 approvals.invalidateForCreativeRevisionChange: the review module registers it in Phase 5; no-op until then. */
export type RevisionChangeHook = (documentId: string, tx: Tx) => Promise<void>;
let revisionChangeHook: RevisionChangeHook = async () => undefined;
export const registerRevisionChangeHook = (fn: RevisionChangeHook): void => {
  revisionChangeHook = fn;
};

// ---- helpers ----

const DEFAULT_FORMAT_KEY = 'square_1080';

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const documentResource = (d: DocumentRow) => ({
  type: 'creative_document',
  tenantId: d.tenantId,
  brandId: d.brandId,
  id: d.id,
});
const templateResource = (t: TemplateRow) => ({
  type: 'template',
  tenantId: t.tenantId,
  brandId: t.brandId,
  id: t.id,
});

/** Revision authorship (creative_revisions.author_kind): a service principal is an agent; everyone else is a person. */
const authorKindOf = (actor: ResolvedActor): 'user' | 'agent' =>
  actor.kind === 'service_principal' ? 'agent' : 'user';
const requesterKindOf = (actor: ResolvedActor): 'user' | 'agent' | 'system' =>
  actor.kind === 'user' ? 'user' : actor.kind === 'service_principal' ? 'agent' : 'system';
function commentAuthorKindOf(actor: ResolvedActor): 'user' | 'agent' | 'external_reviewer' {
  switch (actor.kind) {
    case 'user':
      return 'user';
    case 'service_principal':
      return 'agent';
    case 'external_reviewer':
      return 'external_reviewer';
    case 'platform_operator':
      throw new PolicyDeniedError('support_never', 'Support sessions cannot comment on creative work');
  }
}

/** The guards key on batch.origin, so an agent may never label its batch as a person's (a person may commit an agent proposal). */
function assertOrigin(actor: ResolvedActor, origin: 'user' | 'agent'): void {
  if (actor.kind === 'service_principal' && origin !== 'agent')
    throw new PolicyDeniedError('origin_mismatch', 'An agent must submit its batches with origin agent');
}

/** Spec 5.5: agents hold brand.edit_standards with the propose_only obligation; approving a template is a person's decision. */
function assertMayDecide(decision: Decision): void {
  if (decision.obligations?.some((o) => o.type === 'propose_only'))
    throw new PolicyDeniedError('propose_only', 'Agents may only propose; a brand manager must decide');
}

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
  path: string,
): S {
  try {
    return machine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

const isBlocking = (f: Finding) => f.severity === 'blocking';
const findingDetail = (f: Finding): ErrorDetail => ({
  path: [f.pageId, f.elementId].filter((p): p is string => p !== undefined).join('.') || 'document',
  issue: `${f.code}: ${f.message}`,
});
/** Spec 11.4: agent proposals must be clean; humans see warnings and the commit proceeds. */
function assertAgentClean(origin: 'user' | 'agent', findings: Finding[]): void {
  if (origin === 'agent' && findings.some(isBlocking))
    throw new ValidationFailedError(
      findings.filter(isBlocking).map(findingDetail),
      'Agent proposals must have no blocking findings',
    );
}

/** Document-owned rows are loaded through the scoped repository and bound to the document: a foreign or mismatched id is NOT_FOUND. */
async function loadRevision(doc: DocumentRow, revisionId: string, tx?: Tx) {
  const r = await revisionsRepo.getById(revisionId, tx);
  if (r.documentId !== doc.id || r.brandId !== doc.brandId)
    throw new NotFoundError('CreativeRevision', revisionId);
  return r;
}
async function loadComment(doc: DocumentRow, commentId: string, tx?: Tx) {
  const c = await commentsRepo.getById(commentId, tx);
  if (c.documentId !== doc.id || c.brandId !== doc.brandId)
    throw new NotFoundError('ElementComment', commentId);
  return c;
}
async function loadTemplateVersion(template: TemplateRow, templateVersionId: string, tx?: Tx) {
  const v = await templateVersionsRepo.getById(templateVersionId, tx);
  if (v.templateId !== template.id || v.brandId !== template.brandId)
    throw new NotFoundError('TemplateVersion', templateVersionId);
  return v;
}
async function loadCurrentRevision(doc: DocumentRow, tx?: Tx) {
  if (!doc.currentRevisionId) throw new NotFoundError('CreativeRevision', doc.id);
  return loadRevision(doc, doc.currentRevisionId, tx);
}

/**
 * Spec 8.3 / 11.4: the brand snapshot a document is designed against. A brand without a published version cannot
 * host a document; the brand module reports that as NOT_FOUND on the published version, which is a validation
 * problem with the request here, not a missing resource.
 */
async function resolveSnapshot(
  actor: ResolvedActor,
  brandId: string,
  versionId: string | undefined,
  tx?: Tx,
) {
  try {
    return await brandService.resolveBrandSnapshot(actor, { brandId, versionId }, tx);
  } catch (err) {
    if (err instanceof NotFoundError && err.resourceType === 'PublishedBrandVersion')
      throw new ValidationFailedError(
        [{ path: 'brandId', issue: 'brand_has_no_published_version' }],
        'The brand has no published version to design against',
      );
    throw err;
  }
}

/** The minimal valid document (spec 11.2): one page in the default format, no elements. */
function minimalDocument(brandVersionId: string): CreativeDocumentV1 {
  const format = FORMAT_DEFINITIONS[DEFAULT_FORMAT_KEY];
  if (!format) throw new Error(`format ${DEFAULT_FORMAT_KEY} is not defined`);
  return {
    schemaVersion: 1,
    brandVersionId,
    pages: [
      {
        id: 'page_1',
        name: 'Page 1',
        formatKey: format.key,
        width: format.width,
        height: format.height,
        elements: [],
        layoutConstraints: [],
      },
    ],
    variants: [],
  };
}

/**
 * Revision 1 has no parent. Its batch is the addPage sequence that reproduces the snapshot from nothing, so
 * every revision's `operations` replays; baseRevisionId is empty because there is no base (parent_revision_id is null).
 */
const initialBatch = (document: CreativeDocumentV1, origin: 'user' | 'agent'): OperationBatch => ({
  baseRevisionId: '',
  operations: document.pages.map((page, index) => ({ op: 'addPage', page, index })),
  summary: 'Initial document',
  origin,
});

/** Asset versions an element tree references: image, logo and background layers, text fonts; groups recurse. */
function assetRefsIn(elements: readonly Element[]): AssetRef[] {
  const out: AssetRef[] = [];
  for (const el of elements) {
    if (el.type === 'image' || el.type === 'logo')
      out.push({ assetVersionId: el.assetVersionId, purpose: 'creative' });
    else if (el.type === 'background' && el.assetVersionId)
      out.push({ assetVersionId: el.assetVersionId, purpose: 'creative' });
    else if (el.type === 'text') out.push({ assetVersionId: el.style.fontAssetVersionId, purpose: 'font' });
    else if (el.type === 'group') out.push(...assetRefsIn(el.children));
  }
  return out;
}

/** Spec 11.4 guardAssets: the asset versions an operation introduces into the document. */
function referencedAssetRefs(op: Operation, template: TemplateDocument | undefined): AssetRef[] {
  switch (op.op) {
    case 'insertElement':
      return assetRefsIn([op.element]);
    case 'replaceAsset':
      return [{ assetVersionId: op.assetVersionId, purpose: 'creative' }];
    case 'setStyle': {
      const font = op.patch['fontAssetVersionId'];
      return typeof font === 'string' ? [{ assetVersionId: font, purpose: 'font' }] : [];
    }
    case 'addPage':
      return assetRefsIn(op.page.elements);
    case 'applyTemplate':
      return template ? assetRefsIn(template.page.elements) : [];
    default:
      return [];
  }
}

/** One authorisation per distinct (asset version, purpose) pair. */
function distinctRefs(refs: readonly AssetRef[]): AssetRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.purpose}:${r.assetVersionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const elementIdsOfPage = (doc: CreativeDocumentV1, pageId: string): string[] => {
  const page = doc.pages.find((p) => p.id === pageId);
  return page ? allElementIds({ ...doc, pages: [page] }) : [];
};

/**
 * applyTemplate needs the template version document (the reducer never fetches). Only approved versions of the
 * document's own brand can be applied; the template page in the target page's format is used, else the first page.
 */
async function resolveTemplate(
  doc: DocumentRow,
  op: Extract<Operation, { op: 'applyTemplate' }>,
  current: CreativeDocumentV1,
  index: number,
  tx: Tx,
): Promise<TemplateDocument> {
  const tv = await templateVersionsRepo.getById(op.templateVersionId, tx);
  if (tv.brandId !== doc.brandId) throw new NotFoundError('TemplateVersion', op.templateVersionId);
  if (tv.state !== 'approved')
    throw new ValidationFailedError(
      [{ path: `operations.${index}.templateVersionId`, issue: 'template_version_not_approved' }],
      'Only approved template versions can be applied',
    );
  const document = CreativeDocumentV1.parse(tv.document);
  const target = current.pages.find((p) => p.id === op.pageId);
  const page =
    document.pages.find((p) => target !== undefined && p.formatKey === target.formatKey) ?? document.pages[0];
  if (!page)
    throw new ValidationFailedError([
      { path: `operations.${index}.templateVersionId`, issue: 'template_has_no_pages' },
    ]);
  return { page, slots: TemplateSlot.array().parse(tv.slots) };
}

/**
 * Spec 11.4, the pure part shared by apply and propose: guards, asset authorisation and the reducer per operation,
 * then schema bounds and brand validation. Nothing is written here.
 */
async function evaluateBatch(
  actor: ResolvedActor,
  doc: DocumentRow,
  base: RevisionRow,
  batch: OperationBatch,
  tx: Tx,
) {
  const baseDocument = CreativeDocumentV1.parse(base.snapshot);
  const snapshot = await resolveSnapshot(actor, doc.brandId, baseDocument.brandVersionId, tx);
  let next = structuredClone(baseDocument);
  const templates: Record<string, TemplateDocument> = {};
  const changed = new Set(changedElementIds(batch));
  for (const [index, op] of batch.operations.entries()) {
    try {
      guardProtected(next, op, batch.origin); // agents cannot touch protected elements
      guardLogoInsertion(op, batch.origin); // agents cannot add logos
      if (op.op === 'applyTemplate') {
        templates[op.templateVersionId] ??= await resolveTemplate(doc, op, next, index, tx);
        for (const id of elementIdsOfPage(next, op.pageId)) changed.add(id); // every element of the page is replaced
      }
      const template = op.op === 'applyTemplate' ? templates[op.templateVersionId] : undefined;
      for (const ref of distinctRefs(referencedAssetRefs(op, template)))
        await assetAuthoriser(
          ref.assetVersionId,
          { tenantId: doc.tenantId, brandId: doc.brandId, purpose: ref.purpose },
          tx,
        );
      next = reduce(next, op, { templates }); // pure; packages/editor/src/reduce.ts
    } catch (err) {
      if (err instanceof OperationError)
        throw new ValidationFailedError(
          [{ path: `operations.${index}`, issue: err.code }],
          'An operation could not be applied to the document',
        );
      throw err;
    }
  }
  const parsed = CreativeDocumentV1.parse(next); // schema bounds
  const findings = validateAgainstBrand(parsed, snapshot); // tokens, logo rules, min sizes, contrast, facts
  return { next: parsed, findings, contentHash: hashCanonical(parsed), changedElementIds: [...changed] };
}

async function assertStale(doc: DocumentRow, baseRevisionId: string) {
  if (!doc.currentRevisionId || doc.currentRevisionId !== baseRevisionId)
    throw new StaleRevisionError(doc.currentRevisionId ?? ''); // 409; the client rebases or branches
}

// ---- DTO mappers: JSON documents are validated on read as well as on write (spec 6.1) ----

const StringList = z.array(z.string());

const toDocumentDto = (d: DocumentRow) => ({
  id: d.id,
  brandId: d.brandId,
  contentPackageId: d.contentPackageId,
  title: d.title,
  currentRevisionId: d.currentRevisionId,
  schemaVersion: d.schemaVersion,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  version: d.version,
});
const toRevisionDto = (r: RevisionRow) => ({
  id: r.id,
  documentId: r.documentId,
  parentRevisionId: r.parentRevisionId,
  number: r.number,
  brandVersionId: r.brandVersionId,
  agentRunId: r.agentRunId,
  authorKind: r.authorKind,
  authorId: r.authorId,
  changeSummary: r.changeSummary,
  operations: OperationBatch.parse(r.operations),
  snapshot: CreativeDocumentV1.parse(r.snapshot),
  contentHash: r.contentHash,
  createdAt: r.createdAt.toISOString(),
});
const toRevisionSummary = (r: RevisionRow) => {
  const { operations: _operations, snapshot: _snapshot, ...summary } = toRevisionDto(r);
  return summary;
};
const toCommentDto = (c: CommentRow) => ({
  id: c.id,
  documentId: c.documentId,
  revisionId: c.revisionId,
  elementId: c.elementId,
  body: c.body,
  authorKind: c.authorKind,
  authorId: c.authorId,
  state: c.state,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
  version: c.version,
});
/** Storage keys and hashes only: delivery is the assets media endpoint, never a URL from here. */
const toExportDto = (e: ExportRow) => ({
  id: e.id,
  revisionId: e.revisionId,
  pageId: e.pageId,
  formatKey: e.formatKey,
  mime: e.mime,
  width: e.width,
  height: e.height,
  bytes: e.bytes,
  storageKey: e.storageKey,
  contentHash: e.contentHash,
  rendererVersion: e.rendererVersion,
  manifest: RenderManifest.parse(e.manifest),
  validation: RenderValidationResult.parse(e.validation),
  createdAt: e.createdAt.toISOString(),
});
const exportIdsOf = (j: RenderJobRow) => StringList.parse(j.exportIds ?? []);
/** Exports in the order the worker recorded them (render_jobs.export_ids): ids minted in the same millisecond do not sort by time. */
const orderedExports = (exportIds: readonly string[], exports: ExportRow[]) => {
  const byId = new Map(exports.map((e) => [e.id, e]));
  return exportIds.map((id) => byId.get(id)).filter((e): e is ExportRow => e !== undefined);
};
const toRenderJobDto = (j: RenderJobRow, exports: ExportRow[]) => ({
  id: j.id,
  brandId: j.brandId,
  revisionId: j.revisionId,
  formatKeys: StringList.parse(j.formatKeys),
  state: j.state,
  attempts: j.attempts,
  error: j.error,
  requestedByKind: j.requestedByKind,
  requestedById: j.requestedById,
  exportIds: exportIdsOf(j),
  exports: orderedExports(exportIdsOf(j), exports).map(toExportDto),
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
  version: j.version,
});
const toTemplateDto = (t: TemplateRow) => ({
  id: t.id,
  brandId: t.brandId,
  name: t.name,
  currentVersionId: t.currentVersionId,
  state: t.state,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
  version: t.version,
});
const toTemplateVersionDto = (v: TemplateVersionRow) => ({
  id: v.id,
  templateId: v.templateId,
  number: v.number,
  slots: TemplateSlot.array().parse(v.slots),
  constraints: v.constraints,
  formats: StringList.parse(v.formats),
  document: CreativeDocumentV1.parse(v.document),
  contentHash: v.contentHash,
  state: v.state,
  createdAt: v.createdAt.toISOString(),
});
const toTemplateVersionSummary = (v: TemplateVersionRow) => {
  const { document: _document, ...summary } = toTemplateVersionDto(v);
  return summary;
};

export const creativeService = {
  documents: {
    /**
     * Spec 11.1/11.4: a document is born with revision 1 in the same transaction. It is designed against the
     * brand's published version (the snapshot's brandVersionId is authoritative) and every asset the initial
     * document references is authorised, exactly as an operation would be.
     */
    async create(
      actor: ResolvedActor,
      input: z.infer<typeof DocumentCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = DocumentCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'creative.edit', brandResource(brand.id), opts, tx);
      const snapshot = await resolveSnapshot(actor, brand.id, undefined, tx);
      const document = CreativeDocumentV1.parse({
        ...(parsed.document ?? minimalDocument(snapshot.brandVersionId)),
        brandVersionId: snapshot.brandVersionId,
      });
      const { tenantId } = requireTenant();
      for (const ref of distinctRefs(assetRefsIn(document.pages.flatMap((p) => p.elements))))
        await assetAuthoriser(ref.assetVersionId, { tenantId, brandId: brand.id, purpose: ref.purpose }, tx);
      const origin = authorKindOf(actor);
      const findings = validateAgainstBrand(document, snapshot);
      assertAgentClean(origin, findings);
      const documentId = newId('creativeDocument');
      const revisionId = newId('creativeRevision');
      const contentHash = hashCanonical(document);
      await documentsRepo.create(
        {
          id: documentId,
          brandId: brand.id,
          contentPackageId: parsed.contentPackageId ?? null,
          title: parsed.title,
          currentRevisionId: null,
          schemaVersion: document.schemaVersion,
        },
        tx,
      );
      await revisionsRepo.create(
        {
          id: revisionId,
          brandId: brand.id,
          documentId,
          parentRevisionId: null,
          number: 1,
          brandVersionId: snapshot.brandVersionId,
          agentRunId: null,
          authorKind: origin,
          authorId: actor.id,
          changeSummary: 'Initial document',
          operations: initialBatch(document, origin),
          snapshot: document,
          contentHash,
        },
        tx,
      );
      await documentsRepo.setCurrentRevision(documentId, 0, revisionId, tx);
      await audit.record(
        actorRef(actor),
        'creative.document.create',
        { type: 'creative_document', id: documentId },
        'allowed',
        tx,
        { brandId: brand.id, revisionId },
      );
      await outbox.add(
        'creative.revision_created',
        { type: 'creative_document', id: documentId, version: 1 },
        { documentId, revisionId, number: 1, contentHash, brandVersionId: snapshot.brandVersionId },
        tx,
        { brandId: brand.id },
      );
      return { documentId, revisionId, number: 1, version: 1, contentHash, findings };
    },

    /** Save/reopen: the document row plus the committed snapshot of its current revision. */
    async get(actor: ResolvedActor, input: z.infer<typeof DocumentGet>, tx?: Tx) {
      const parsed = DocumentGet.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const current = await loadCurrentRevision(doc, tx);
      return { ...toDocumentDto(doc), revision: toRevisionDto(current) };
    },
  },

  revisions: {
    /** History is never rewritten: every revision of the document, newest first. */
    async list(actor: ResolvedActor, input: z.infer<typeof RevisionList>, tx?: Tx) {
      const parsed = RevisionList.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const page = await revisionsRepo.list(doc.brandId, doc.id, parsed.page, tx);
      return { items: page.items.map(toRevisionSummary), nextCursor: page.nextCursor };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof RevisionGet>, tx?: Tx) {
      const parsed = RevisionGet.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      return toRevisionDto(await loadRevision(doc, parsed.revisionId, tx));
    },
  },

  operations: {
    /**
     * Spec 11.4 applyOperations, literally: lock + load (tenant-scoped), policy, stale check (409), base revision,
     * brand snapshot pinned to the base's brand version, guards + asset authorisation + reduce per operation,
     * schema bounds, brand validation (agents must be clean), insert-only revision, optimistic head move,
     * comment outdating, outbox event, approvals hook, audit. All in the caller's transaction.
     */
    async apply(
      actor: ResolvedActor,
      input: z.infer<typeof OperationsApply>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const { documentId, ...batch } = OperationsApply.parse(input);
      const doc = await documentsRepo.lock(documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      assertOrigin(actor, batch.origin);
      await assertStale(doc, batch.baseRevisionId);
      const base = await loadRevision(doc, batch.baseRevisionId, tx);
      const evaluated = await evaluateBatch(actor, doc, base, batch, tx);
      assertAgentClean(batch.origin, evaluated.findings);
      const revisionId = newId('creativeRevision');
      const number = base.number + 1;
      await revisionsRepo.create(
        {
          id: revisionId,
          brandId: doc.brandId,
          documentId: doc.id,
          parentRevisionId: base.id,
          number,
          brandVersionId: evaluated.next.brandVersionId,
          agentRunId: batch.agentRunId ?? null,
          authorKind: batch.origin,
          authorId: actor.id,
          changeSummary: batch.summary,
          operations: batch,
          snapshot: evaluated.next,
          contentHash: evaluated.contentHash,
        },
        tx,
      );
      await documentsRepo.setCurrentRevision(doc.id, doc.version, revisionId, tx);
      const outdatedComments = await commentsRepo.markOutdated(
        doc.brandId,
        doc.id,
        evaluated.changedElementIds,
        tx,
      ); // anchored comments never silently drift
      await outbox.add(
        'creative.revision_created',
        { type: 'creative_document', id: doc.id, version: doc.version + 1 },
        {
          documentId: doc.id,
          revisionId,
          number,
          contentHash: evaluated.contentHash,
          brandVersionId: evaluated.next.brandVersionId,
        },
        tx,
        { brandId: doc.brandId },
      );
      await revisionChangeHook(doc.id, tx); // any approval bound to the old hash (Phase 5)
      await audit.record(
        actorRef(actor),
        'creative.operations.apply',
        { type: 'creative_revision', id: revisionId },
        'allowed',
        tx,
        { brandId: doc.brandId, revisionId, count: batch.operations.length, runId: batch.agentRunId ?? null },
      );
      return {
        revision: toRevisionDto(await revisionsRepo.getById(revisionId, tx)),
        findings: evaluated.findings,
        outdatedComments,
        version: doc.version + 1,
      };
    },

    /**
     * Spec 11.4 agent flow: the same guards, reduction and validation as a dry run, nothing written. Findings are
     * returned even when blocking; the caller (agent run or studio overlay) decides what to do with them.
     */
    async propose(
      actor: ResolvedActor,
      input: z.infer<typeof OperationsPropose>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const { documentId, ...batch } = OperationsPropose.parse(input);
      const doc = await documentsRepo.getById(documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      assertOrigin(actor, batch.origin);
      await assertStale(doc, batch.baseRevisionId);
      const base = await loadRevision(doc, batch.baseRevisionId, tx);
      const {
        next,
        findings,
        contentHash,
        changedElementIds: changed,
      } = await evaluateBatch(actor, doc, base, batch, tx);
      return {
        baseRevisionId: base.id,
        snapshot: next,
        contentHash,
        findings,
        changedElementIds: changed,
        blocking: findings.some(isBlocking),
      };
    },
  },

  renders: {
    /** Spec 11.5: a render job per revision and set of formats; the worker picks it up from the outbox event. */
    async request(
      actor: ResolvedActor,
      input: z.infer<typeof RenderRequest>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = RenderRequest.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.render', documentResource(doc), opts, tx);
      const revision = await loadRevision(doc, parsed.revisionId, tx);
      const formatKeys = [...new Set(parsed.formatKeys)];
      const unknown = formatKeys.filter((k) => FORMAT_DEFINITIONS[k] === undefined);
      if (unknown.length)
        throw new ValidationFailedError(
          unknown.map((k) => ({ path: 'formatKeys', issue: `unknown format ${k}` })),
        );
      const id = newId('renderJob');
      await renderJobsRepo.create(
        {
          id,
          brandId: doc.brandId,
          revisionId: revision.id,
          formatKeys,
          state: 'pending',
          attempts: 0,
          error: null,
          requestedByKind: requesterKindOf(actor),
          requestedById: actor.id,
          exportIds: null,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.render.request',
        { type: 'render_job', id },
        'allowed',
        tx,
        { brandId: doc.brandId, revisionId: revision.id },
      );
      await outbox.add(
        'creative.render_requested',
        { type: 'render_job', id, version: 0 },
        {
          renderJobId: id,
          documentId: doc.id,
          revisionId: revision.id,
          formatKeys: formatKeys.join(','),
          actorKind: actor.kind,
          actorId: actor.id,
        },
        tx,
        { brandId: doc.brandId },
      );
      return { renderJobId: id, state: 'pending' as const, version: 0 };
    },

    /** The job with its exports: storage keys and hashes only (delivery is the assets media endpoint). */
    async get(actor: ResolvedActor, input: z.infer<typeof RenderGet>, tx?: Tx) {
      const parsed = RenderGet.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const doc = await documentsRepo.getById(revision.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      return toRenderJobDto(job, await exportsRepo.listByIds(job.brandId, exportIdsOf(job), tx));
    },

    /** Render worker (Phase 3 render stream): the job moves only by renderJobMachine; the worker never sets a state string. */
    async markRendering(input: z.infer<typeof RenderMarkRendering>, tx: Tx) {
      const parsed = RenderMarkRendering.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const toState = transition(renderJobMachine, job.state, 'start', 'renderJobId');
      await renderJobsRepo.update(job.id, job.version, { state: toState, attempts: job.attempts + 1 }, tx);
      await audit.record(
        requireTenant().actor,
        'creative.render.start',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        { brandId: job.brandId, fromState: job.state, toState },
      );
      return { renderJobId: job.id, state: toState, attempts: job.attempts + 1, version: job.version + 1 };
    },

    /** Exports are insert-only evidence: each carries its manifest (fonts, asset versions, hashes) and validation result. */
    async markReady(input: z.infer<typeof RenderMarkReady>, tx: Tx) {
      const parsed = RenderMarkReady.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const toState = transition(renderJobMachine, job.state, 'succeed', 'renderJobId');
      const revision = await revisionsRepo.getById(job.revisionId, tx);
      const pageIds = new Set(CreativeDocumentV1.parse(revision.snapshot).pages.map((p) => p.id));
      const formats = new Set(StringList.parse(job.formatKeys));
      const details: ErrorDetail[] = [];
      parsed.exports.forEach((e, i) => {
        if (!pageIds.has(e.pageId))
          details.push({ path: `exports.${i}.pageId`, issue: 'page_not_in_revision' });
        if (!formats.has(e.formatKey))
          details.push({ path: `exports.${i}.formatKey`, issue: 'format_not_requested' });
      });
      if (details.length) throw new ValidationFailedError(details);
      const exportIds: string[] = [];
      for (const e of parsed.exports) {
        const id = newId('renderedExport');
        await exportsRepo.create({ id, brandId: job.brandId, revisionId: revision.id, ...e }, tx);
        exportIds.push(id);
      }
      await renderJobsRepo.update(job.id, job.version, { state: toState, exportIds, error: null }, tx);
      await audit.record(
        requireTenant().actor,
        'creative.render.ready',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        {
          brandId: job.brandId,
          fromState: job.state,
          toState,
          count: exportIds.length,
          revisionId: revision.id,
        },
      );
      await outbox.add(
        'creative.render_completed',
        { type: 'render_job', id: job.id, version: job.version + 1 },
        { renderJobId: job.id, revisionId: revision.id, state: toState, exportCount: exportIds.length },
        tx,
        { brandId: job.brandId },
      );
      return { renderJobId: job.id, state: toState, exportIds, version: job.version + 1 };
    },

    async markFailed(input: z.infer<typeof RenderMarkFailed>, tx: Tx) {
      const parsed = RenderMarkFailed.parse(input);
      const job = await renderJobsRepo.getById(parsed.renderJobId, tx);
      const toState = transition(renderJobMachine, job.state, 'fail', 'renderJobId');
      await renderJobsRepo.update(job.id, job.version, { state: toState, error: parsed.error }, tx);
      await audit.record(
        requireTenant().actor,
        'creative.render.fail',
        { type: 'render_job', id: job.id },
        'allowed',
        tx,
        { brandId: job.brandId, fromState: job.state, toState, reason: parsed.error.slice(0, 200) },
      );
      await outbox.add(
        'creative.render_completed',
        { type: 'render_job', id: job.id, version: job.version + 1 },
        { renderJobId: job.id, revisionId: job.revisionId, state: toState, exportCount: 0 },
        tx,
        { brandId: job.brandId },
      );
      return { renderJobId: job.id, state: toState, version: job.version + 1 };
    },
  },

  comments: {
    /** Anyone who can read the document can comment (reviewers, agents); the anchor element must exist in the revision. */
    async add(actor: ResolvedActor, input: z.infer<typeof CommentAdd>, tx: Tx, opts: ActorOptions = {}) {
      const parsed = CommentAdd.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), opts, tx);
      const authorKind = commentAuthorKindOf(actor);
      const revision = await loadRevision(doc, parsed.revisionId, tx);
      const snapshot = CreativeDocumentV1.parse(revision.snapshot);
      if (!snapshot.pages.some((p) => findElement(p, parsed.elementId)))
        throw new ValidationFailedError([{ path: 'elementId', issue: 'element_not_in_revision' }]);
      const id = newId('elementComment');
      await commentsRepo.create(
        {
          id,
          brandId: doc.brandId,
          documentId: doc.id,
          revisionId: revision.id,
          elementId: parsed.elementId,
          body: parsed.body,
          authorKind,
          authorId: actor.id,
          state: 'open',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.comment.add',
        { type: 'element_comment', id },
        'allowed',
        tx,
        { brandId: doc.brandId, revisionId: revision.id },
      );
      return { commentId: id, state: 'open' as const, version: 0 };
    },

    /** Resolving is an edit of the document's review state: open or outdated → resolved, once. */
    async resolve(
      actor: ResolvedActor,
      input: z.infer<typeof CommentResolve>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = CommentResolve.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.edit', documentResource(doc), opts, tx);
      const comment = await loadComment(doc, parsed.commentId, tx);
      if (comment.state === 'resolved')
        throw new ValidationFailedError([{ path: 'commentId', issue: 'already_resolved' }]);
      await commentsRepo.update(comment.id, parsed.expectedVersion, { state: 'resolved' }, tx);
      await audit.record(
        actorRef(actor),
        'creative.comment.resolve',
        { type: 'element_comment', id: comment.id },
        'allowed',
        tx,
        {
          brandId: doc.brandId,
          fromState: comment.state,
          toState: 'resolved',
          expectedVersion: parsed.expectedVersion,
        },
      );
      return { commentId: comment.id, state: 'resolved' as const, version: parsed.expectedVersion + 1 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof CommentList>, tx?: Tx) {
      const parsed = CommentList.parse(input);
      const doc = await documentsRepo.getById(parsed.documentId, tx);
      await policy.assert(actor, 'creative.read', documentResource(doc), {}, tx);
      const page = await commentsRepo.list(doc.brandId, doc.id, parsed.state, parsed.page, tx);
      return { items: page.items.map(toCommentDto), nextCursor: page.nextCursor };
    },
  },

  /** Spec 6.3 templates: a brand-owned template with numbered versions; only approved versions can be applied (spec 11.3). */
  templates: {
    async create(
      actor: ResolvedActor,
      input: z.infer<typeof TemplateCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = TemplateCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'creative.edit', brandResource(brand.id), opts, tx);
      const id = newId('template');
      await templatesRepo.create(
        { id, brandId: brand.id, name: parsed.name, currentVersionId: null, state: 'draft' },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.template.create',
        { type: 'template', id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { templateId: id, state: 'draft' as const, version: 0 };
    },

    /** Every slot must point at an element of the template document; formats must be known. Versions start as drafts. */
    async createVersion(
      actor: ResolvedActor,
      input: z.infer<typeof TemplateVersionCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = TemplateVersionCreate.parse(input);
      const template = await templatesRepo.lock(parsed.templateId, tx);
      await policy.assert(actor, 'creative.edit', templateResource(template), opts, tx);
      const document = CreativeDocumentV1.parse(parsed.document);
      const elementIds = new Set(allElementIds(document));
      const keys = new Set<string>();
      const details: ErrorDetail[] = [];
      parsed.slots.forEach((slot, i) => {
        if (keys.has(slot.key)) details.push({ path: `slots.${i}.key`, issue: 'duplicate_slot_key' });
        keys.add(slot.key);
        if (!elementIds.has(slot.elementId))
          details.push({ path: `slots.${i}.elementId`, issue: 'element_not_in_document' });
      });
      parsed.formats.forEach((f, i) => {
        if (FORMAT_DEFINITIONS[f] === undefined)
          details.push({ path: `formats.${i}`, issue: `unknown format ${f}` });
      });
      if (details.length) throw new ValidationFailedError(details);
      const id = newId('templateVersion');
      const number = await templateVersionsRepo.nextNumber(template.brandId, template.id, tx);
      const contentHash = hashCanonical(document);
      await templateVersionsRepo.create(
        {
          id,
          brandId: template.brandId,
          templateId: template.id,
          number,
          slots: parsed.slots,
          constraints: parsed.constraints,
          formats: parsed.formats,
          document,
          contentHash,
          state: 'draft',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.template.create_version',
        { type: 'template_version', id },
        'allowed',
        tx,
        { brandId: template.brandId },
      );
      return { templateVersionId: id, number, state: 'draft' as const, contentHash };
    },

    /**
     * Approval is a brand-standards decision (brand.edit_standards, never an agent): the version becomes approved,
     * the template points at it as current and becomes active on its first approval.
     */
    async approve(
      actor: ResolvedActor,
      input: z.infer<typeof TemplateApprove>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = TemplateApprove.parse(input);
      const template = await templatesRepo.lock(parsed.templateId, tx);
      const tv = await loadTemplateVersion(template, parsed.templateVersionId, tx);
      const decision = await policy.assert(
        actor,
        'brand.edit_standards',
        {
          type: 'template_version',
          tenantId: template.tenantId,
          brandId: template.brandId,
          id: tv.id,
          state: tv.state,
        },
        opts,
        tx,
      );
      assertMayDecide(decision);
      const toState = transition(templateVersionMachine, tv.state, 'approve', 'templateVersionId');
      const templateState =
        template.state === 'active'
          ? template.state
          : transition(templateMachine, template.state, 'activate', 'templateId');
      await templateVersionsRepo.setState(tv.id, template.brandId, tv.state, toState, tx);
      await templatesRepo.update(
        template.id,
        parsed.expectedVersion,
        { currentVersionId: tv.id, state: templateState },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'creative.template.approve',
        { type: 'template_version', id: tv.id },
        'allowed',
        tx,
        { brandId: template.brandId, fromState: tv.state, toState, expectedVersion: parsed.expectedVersion },
      );
      return {
        templateId: template.id,
        templateVersionId: tv.id,
        state: toState,
        templateState,
        version: parsed.expectedVersion + 1,
      };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof TemplateList>, tx?: Tx) {
      const parsed = TemplateList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'creative.read', brandResource(brand.id), {}, tx);
      const page = await templatesRepo.list(brand.id, parsed.page, tx);
      return { items: page.items.map(toTemplateDto), nextCursor: page.nextCursor };
    },

    /** The template, its versions (summaries, newest first) and one full version (selectedVersion): the requested one, else the current one. */
    async get(actor: ResolvedActor, input: z.infer<typeof TemplateGet>, tx?: Tx) {
      const parsed = TemplateGet.parse(input);
      const template = await templatesRepo.getById(parsed.templateId, tx);
      await policy.assert(actor, 'creative.read', templateResource(template), {}, tx);
      const versions = await templateVersionsRepo.listForTemplate(template.brandId, template.id, tx);
      const selectedId = parsed.templateVersionId ?? template.currentVersionId;
      const selected = selectedId ? await loadTemplateVersion(template, selectedId, tx) : null;
      return {
        ...toTemplateDto(template),
        versions: versions.map(toTemplateVersionSummary),
        selectedVersion: selected ? toTemplateVersionDto(selected) : null,
      };
    },
  },
};
