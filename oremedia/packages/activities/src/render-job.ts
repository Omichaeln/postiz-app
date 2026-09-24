import { createHash } from 'node:crypto';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Finding,
  RenderExportInput,
  RenderJobState,
} from '@oremedia/contracts/creative';
import {
  NotFoundError,
  OremediaError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type {
  RenderAssetRef,
  RenderFontRef,
  RenderJobActivitiesV1,
  RenderResolveResult,
  RenderTarget,
} from '@oremedia/contracts/render';
import { withTransaction, type Tx } from '@oremedia/db';
import {
  AssetVersionRepository,
  assetService,
  parseStorageKey,
  storage,
  type StorageProvider,
} from '@oremedia/module-assets';
import { brandService } from '@oremedia/module-brand';
import { METRIC, count, logger, record } from '@oremedia/observability';
import { loadActorGrants, resolveActivityActor } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Spec 11.5 activities for renderJobWorkflowV1: thin wrappers that establish tenant context (re-loading the
 * requester's grants), pin every input through the modules (revision snapshot, brand snapshot, asset versions via
 * authoriseUse) and hand the actual drawing to a FormatRenderer the worker supplies (apps/worker-render: headless
 * Chromium + the render-only editor bundle). Bytes move only between the object store and the browser; Temporal
 * payloads carry storage keys and hashes.
 */

/** The creative module's render-job surface as the worker needs it (apps/worker-render adapts creativeService). */
export interface RenderJobStore {
  getJob(
    actor: ResolvedActor,
    renderJobId: string,
  ): Promise<{
    renderJobId: string;
    state: RenderJobState;
    revisionId: string;
    documentId: string;
    brandId: string;
    formatKeys: string[];
  }>;
  getRevision(
    actor: ResolvedActor,
    documentId: string,
    revisionId: string,
  ): Promise<{ snapshot: CreativeDocumentV1; contentHash: string; brandVersionId: string }>;
  markRendering(renderJobId: string, tx: Tx): Promise<void>;
  markReady(renderJobId: string, exports: RenderExportInput[], tx: Tx): Promise<{ exportIds: string[] }>;
  markFailed(renderJobId: string, error: string, tx: Tx): Promise<void>;
}

export interface RenderTargetInput {
  document: CreativeDocumentV1;
  page: CreativePage;
  formatKey: string;
  /** The page's own format differs from formatKey: the renderer reflows it (spec 11.3 createFormatVariant). */
  reflow: boolean;
  snapshot: BrandSnapshot;
  fonts: Array<{ family: string; mime: string; bytes: Buffer }>;
  assets: Array<{ assetVersionId: string; mime: string; bytes: Buffer }>;
  limits?: { maxBytes?: number; maxWidth?: number; maxHeight?: number };
}

export interface RenderTargetOutput {
  png: Buffer;
  width: number;
  height: number;
  findings: Finding[];
}

/** Draws one page at one format and runs the spec 11.5 checks; implemented in apps/worker-render. */
export interface FormatRenderer {
  render(input: RenderTargetInput): Promise<RenderTargetOutput>;
}

export interface RenderJobDeps {
  store: RenderJobStore;
  renderer: FormatRenderer;
  /** packages/editor RENDERER_VERSION, recorded in every manifest. */
  rendererVersion: string;
  storage?: StorageProvider;
  /** Cap on (page × format) exports per job (creative.renders.markReady accepts at most 100). */
  maxExports?: number;
}

/** Bytes in the object store do not hash to what the manifest or the render recorded. Never retried. */
export class RenderIntegrityError extends OremediaError {
  constructor(storageKey: string, expected: string, actual: string) {
    super('INTERNAL', 'Stored bytes do not match the recorded hash', {
      details: [
        { path: storageKey, issue: `expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…` },
      ],
    });
  }
}

const DEFAULT_MAX_EXPORTS = 100;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const segment = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/**
 * Where an export lives: under the assets prefix so the tenant-prefixed StorageProvider enforces the tenant, and
 * keyed by revision, job, page and format so a re-render never overwrites an export a review may have approved.
 */
export const exportStorageKey = (
  tenantId: string,
  brandId: string,
  revisionId: string,
  renderJobId: string,
  pageId: string,
  formatKey: string,
): string =>
  `assets/${tenantId}/${brandId}/exports/${revisionId}/${renderJobId}/${segment(pageId)}-${segment(formatKey)}.png`;

function flat(els: Element[]): Element[] {
  const out: Element[] = [];
  for (const el of els) {
    out.push(el);
    if (el.type === 'group') out.push(...flat(el.children));
  }
  return out;
}

/** Every font and image/logo asset version a document references, in first-use order. */
export function referencedAssets(doc: CreativeDocumentV1): {
  fonts: string[];
  images: string[];
  logos: string[];
} {
  const fonts = new Set<string>();
  const images = new Set<string>();
  const logos = new Set<string>();
  for (const page of doc.pages)
    for (const el of flat(page.elements)) {
      if (!el.visible) continue;
      if (el.type === 'text') fonts.add(el.style.fontAssetVersionId);
      else if (el.type === 'image') images.add(el.assetVersionId);
      else if (el.type === 'logo') logos.add(el.assetVersionId);
      else if (el.type === 'background' && el.assetVersionId) images.add(el.assetVersionId);
    }
  return { fonts: [...fonts], images: [...images], logos: [...logos] };
}

/**
 * Which pages render at which formats: a requested format is served by the pages that carry it (format variants
 * created in the studio); a format no page carries is served by the pages of the document's base format,
 * reflowed at render time. Pure, so the same job always yields the same targets.
 */
export function resolveTargets(
  doc: CreativeDocumentV1,
  formatKeys: readonly string[],
): { ok: true; targets: RenderTarget[] } | { ok: false; detail: string } {
  const base = doc.pages[0]?.formatKey;
  const targets: RenderTarget[] = [];
  for (const formatKey of formatKeys) {
    const own = doc.pages.filter((p) => p.formatKey === formatKey);
    const pages = own.length ? own : doc.pages.filter((p) => p.formatKey === base);
    if (!pages.length) return { ok: false, detail: `no page for format ${formatKey}` };
    for (const p of pages) targets.push({ pageId: p.id, formatKey, reflow: own.length === 0 });
  }
  return { ok: true, targets };
}

export function createRenderJobActivities(deps: RenderJobDeps): RenderJobActivitiesV1 {
  const store = () => deps.storage ?? storage();
  const versionsRepo = new AssetVersionRepository();
  const log = () => logger().child('render-job');

  /** The object behind a manifest entry, re-hashed: a pinned input that changed is an integrity failure. */
  const readPinned = async (ref: { storageKey: string; contentHash: string }): Promise<Buffer> => {
    const bytes = await store().getObject(ref.storageKey);
    if (!bytes) throw new NotFoundError('AssetObject', ref.storageKey);
    const actual = sha256(bytes);
    if (actual !== ref.contentHash) throw new RenderIntegrityError(ref.storageKey, ref.contentHash, actual);
    return bytes;
  };

  const pin = async (assetVersionId: string, purpose: 'font' | 'creative' | 'logo', brandId: string) => {
    const authorised = await assetService.authoriseUse(assetVersionId, purpose, { brandId });
    const version = await versionsRepo.findInTenant(authorised.assetVersionId);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    return version;
  };

  return {
    beginRender: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const { actor } = await resolveActivityActor(input);
        const job = await deps.store.getJob(actor, input.renderJobId);
        // A begin re-delivered after the transition committed finds the job already rendering: continue.
        if (job.state === 'pending')
          await withTransaction((tx) => deps.store.markRendering(job.renderJobId, tx));
        else if (job.state !== 'rendering')
          throw new ValidationFailedError(
            [{ path: 'renderJobId', issue: `render_job_${job.state}` }],
            `Render job is ${job.state}`,
          );
        return {
          renderJobId: job.renderJobId,
          revisionId: job.revisionId,
          documentId: job.documentId,
          brandId: job.brandId,
          formatKeys: job.formatKeys,
        };
      }),

    resolveRenderInputs: (input) =>
      inTenant(input, loadActorGrants, async (): Promise<RenderResolveResult> => {
        const { actor } = await resolveActivityActor(input);
        const revision = await deps.store.getRevision(actor, input.documentId, input.revisionId);
        const doc = revision.snapshot;
        // The brand version the revision was made against (spec 11.4); resolving it also re-checks brand.read.
        await brandService.resolveBrandSnapshot(actor, {
          brandId: input.brandId,
          versionId: doc.brandVersionId,
        });
        const targets = resolveTargets(doc, input.formatKeys);
        if (!targets.ok) return { ok: false, reason: 'format_not_in_document', detail: targets.detail };
        const max = deps.maxExports ?? DEFAULT_MAX_EXPORTS;
        if (targets.targets.length > max)
          return {
            ok: false,
            reason: 'too_many_exports',
            detail: `${targets.targets.length} exports requested, at most ${max} per job`,
          };
        const refs = referencedAssets(doc);
        const fonts: RenderFontRef[] = [];
        const assets: RenderAssetRef[] = [];
        try {
          for (const id of refs.fonts) {
            const v = await pin(id, 'font', input.brandId);
            fonts.push({
              assetVersionId: v.id,
              storageKey: v.storageKey,
              contentHash: v.contentHash,
              mime: v.mime,
            });
          }
          for (const [ids, purpose] of [
            [refs.images, 'creative'],
            [refs.logos, 'logo'],
          ] as const) {
            for (const id of ids) {
              const v = await pin(id, purpose, input.brandId);
              assets.push({
                assetVersionId: v.id,
                storageKey: v.storageKey,
                contentHash: v.contentHash,
                mime: v.mime,
                width: v.width,
                height: v.height,
              });
            }
          }
        } catch (err) {
          // Spec 9.2: an ineligible asset is a job outcome, recorded with its reason; nothing is rendered.
          if (err instanceof RightsIneligibleError)
            return {
              ok: false,
              reason: 'rights_ineligible',
              detail: err.details?.map((d) => `${d.path ?? ''}: ${d.issue}`).join('; ') ?? err.message,
            };
          throw err;
        }
        return {
          ok: true,
          rendererVersion: deps.rendererVersion,
          brandVersionId: doc.brandVersionId,
          revisionContentHash: revision.contentHash,
          fonts,
          assets,
          targets: targets.targets,
          manifest: {
            rendererVersion: deps.rendererVersion,
            fonts: fonts.map((f) => ({ assetVersionId: f.assetVersionId, contentHash: f.contentHash })),
            assets: assets.map((a) => ({ assetVersionId: a.assetVersionId, contentHash: a.contentHash })),
            brandVersionId: doc.brandVersionId,
            revisionContentHash: revision.contentHash,
          },
        };
      }),

    renderFormat: (input) =>
      inTenant(input, loadActorGrants, async () => {
        heartbeat('render:load');
        const { actor } = await resolveActivityActor(input);
        const revision = await deps.store.getRevision(actor, input.documentId, input.revisionId);
        const doc = revision.snapshot;
        const page = doc.pages.find((p) => p.id === input.target.pageId);
        if (!page) throw new NotFoundError('CreativePage', input.target.pageId);
        const snapshot = await brandService.resolveBrandSnapshot(actor, {
          brandId: input.brandId,
          versionId: input.brandVersionId,
        });
        // Inputs come from the object store only (the worker has no other egress) and must still hash as pinned.
        const fonts = [];
        for (const f of input.fonts)
          fonts.push({ family: f.assetVersionId, mime: f.mime, bytes: await readPinned(f) });
        const assets = [];
        for (const a of input.assets)
          assets.push({ assetVersionId: a.assetVersionId, mime: a.mime, bytes: await readPinned(a) });
        heartbeat('render:draw');
        const startedAt = Date.now();
        const out = await deps.renderer.render({
          document: doc,
          page,
          formatKey: input.target.formatKey,
          reflow: input.target.reflow,
          snapshot,
          fonts,
          assets,
          ...(input.limits ? { limits: input.limits } : {}),
        });
        // Spec 17.2 render journey: p95 duration per page (one page × format per call), by format.
        record(METRIC.renderDurationMs, Date.now() - startedAt, { formatKey: input.target.formatKey });
        const storageKey = exportStorageKey(
          input.tenantId,
          input.brandId,
          input.revisionId,
          input.renderJobId,
          input.target.pageId,
          input.target.formatKey,
        );
        heartbeat('render:store');
        await store().putObject(storageKey, out.png, { contentType: 'image/png' });
        log().info(
          { brandId: input.brandId, renderJobId: input.renderJobId, formatKey: input.target.formatKey },
          'export rendered',
        );
        return {
          pageId: input.target.pageId,
          formatKey: input.target.formatKey,
          storageKey,
          contentHash: sha256(out.png),
          bytes: out.png.length,
          width: out.width,
          height: out.height,
          mime: 'image/png',
          findings: out.findings,
        };
      }),

    storeExport: (input) =>
      inTenant(input, loadActorGrants, async () => {
        // The export row is evidence (spec 2.1.8): only an object that reads back with the rendered hash is recorded.
        const parsed = parseStorageKey(input.export.storageKey);
        if (!parsed || parsed.tenantId !== input.tenantId)
          throw new ValidationFailedError([{ path: 'storageKey', issue: 'not_in_tenant' }]);
        const bytes = await store().getObject(input.export.storageKey);
        if (!bytes) throw new Error(`export object not readable yet: ${input.export.storageKey}`); // retried
        const actual = sha256(bytes);
        if (actual !== input.export.contentHash || bytes.length !== input.export.bytes)
          throw new RenderIntegrityError(input.export.storageKey, input.export.contentHash, actual);
        return { storageKey: input.export.storageKey, contentHash: actual, bytes: bytes.length };
      }),

    completeRender: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const exports: RenderExportInput[] = input.exports.map((e) => ({
          pageId: e.pageId,
          formatKey: e.formatKey,
          mime: e.mime,
          width: e.width,
          height: e.height,
          bytes: e.bytes,
          storageKey: e.storageKey,
          contentHash: e.contentHash,
          rendererVersion: input.rendererVersion,
          manifest: input.manifest,
          validation: { ok: !e.findings.some((f) => f.severity === 'blocking'), findings: e.findings },
        }));
        const ready = await withTransaction((tx) => deps.store.markReady(input.renderJobId, exports, tx));
        count(METRIC.renderJobs, 1, { result: 'ready' });
        return ready;
      }),

    failRender: (input) =>
      inTenant(input, loadActorGrants, async () => {
        const { actor } = await resolveActivityActor(input);
        const job = await deps.store.getJob(actor, input.renderJobId);
        if (job.state !== 'rendering') {
          // Never started, or already terminal (a re-delivered fail): nothing to move; the reason is logged.
          log().warn(
            { renderJobId: job.renderJobId, state: job.state, reason: input.reason },
            'render job not failed',
          );
          return;
        }
        const error = input.detail ? `${input.reason}: ${input.detail}` : input.reason;
        await withTransaction((tx) => deps.store.markFailed(job.renderJobId, error.slice(0, 2000), tx));
        count(METRIC.renderFailures, 1, { reason: input.reason });
        count(METRIC.renderJobs, 1, { result: 'failed' });
      }),
  };
}
