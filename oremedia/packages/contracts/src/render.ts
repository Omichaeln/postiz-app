import { z } from 'zod';
import { Finding, RenderManifest } from './creative';
import { TenantContextInput } from './tenancy';

/**
 * Spec 11.5 render job workflow contract (renderJobWorkflowV1 on task queue `render`, workflow id
 * `render:<renderJobId>`, args [RenderJobInputV1]). Workflows import only contracts, so every activity input and
 * output lives here. Activity parameters are frozen once deployed: a change ships as a new interface version and
 * a new workflow version. Nothing bigger than storage keys and hashes crosses the activity boundary: the worker
 * reads fonts, assets and its own output from the object store, never from a Temporal payload.
 */
export const RenderJobInputV1 = TenantContextInput.extend({ renderJobId: z.string() });
export type RenderJobInputV1 = z.infer<typeof RenderJobInputV1>;

/** Why a job ends in `failed` (render_jobs.error starts with the reason; detail follows after ': '). */
export const RenderFailureReason = z.enum([
  'rights_ineligible', // an asset version the authoriser rejects at the point of effect (spec 9.2)
  'not_found', // job, revision, brand version or asset version missing in this tenant
  'policy_denied', // the requesting actor may no longer read the document or use the brand
  'format_not_in_document', // no page of the revision matches a requested format and none could be reflowed
  'too_many_exports', // pages × formats above the export cap
  'export_integrity', // the stored object does not hash to what was rendered
  'illegal_state', // the job was not pending/rendering when the worker reached it
  'render_failed', // the browser could not produce the export after retries
  'storage_failed', // the object store refused or lost the export after retries
]);
export type RenderFailureReason = z.infer<typeof RenderFailureReason>;

export type RenderJobResultV1 =
  { outcome: 'ready'; exportIds: string[] } | { outcome: 'failed'; reason: RenderFailureReason };

/** Result of beginRender: the job as it is now (re-loaded; nothing from the request is trusted). */
export const RenderBeginResult = z.object({
  renderJobId: z.string(),
  revisionId: z.string(),
  documentId: z.string(),
  brandId: z.string(),
  formatKeys: z.array(z.string()).min(1),
});
export type RenderBeginResult = z.infer<typeof RenderBeginResult>;

export const RenderResolveInput = RenderJobInputV1.extend({
  revisionId: z.string(),
  documentId: z.string(),
  brandId: z.string(),
  formatKeys: z.array(z.string()).min(1),
});
export type RenderResolveInput = z.infer<typeof RenderResolveInput>;

/** A pinned font: the asset version the worker loads under the family name `assetVersionId`. */
export const RenderFontRef = z.object({
  assetVersionId: z.string(),
  storageKey: z.string(),
  contentHash: z.string().length(64),
  mime: z.string(),
});
export type RenderFontRef = z.infer<typeof RenderFontRef>;

/** A pinned image or logo asset version. */
export const RenderAssetRef = z.object({
  assetVersionId: z.string(),
  storageKey: z.string(),
  contentHash: z.string().length(64),
  mime: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type RenderAssetRef = z.infer<typeof RenderAssetRef>;

/** One export to produce: a page of the revision at a format (reflowed when the page's own format differs). */
export const RenderTarget = z.object({
  pageId: z.string(),
  formatKey: z.string(),
  reflow: z.boolean(),
});
export type RenderTarget = z.infer<typeof RenderTarget>;

export const RenderResolveRejection = z.object({
  ok: z.literal(false),
  reason: RenderFailureReason,
  detail: z.string().max(500).optional(),
});
export type RenderResolveRejection = z.infer<typeof RenderResolveRejection>;

export const RenderResolveSuccess = z.object({
  ok: z.literal(true),
  rendererVersion: z.string(),
  brandVersionId: z.string(),
  revisionContentHash: z.string().length(64),
  fonts: z.array(RenderFontRef),
  assets: z.array(RenderAssetRef),
  targets: z.array(RenderTarget).min(1),
  manifest: RenderManifest,
});
export type RenderResolveSuccess = z.infer<typeof RenderResolveSuccess>;
export type RenderResolveResult = RenderResolveSuccess | RenderResolveRejection;

export const RenderFormatInput = RenderJobInputV1.extend({
  revisionId: z.string(),
  documentId: z.string(),
  brandId: z.string(),
  brandVersionId: z.string(),
  target: RenderTarget,
  fonts: z.array(RenderFontRef),
  assets: z.array(RenderAssetRef),
  rendererVersion: z.string(),
  /** Provider capability limits, when the job is rendered for a known channel (spec 14.6); absent = none. */
  limits: z
    .object({
      maxBytes: z.number().int().positive().optional(),
      maxWidth: z.number().int().positive().optional(),
      maxHeight: z.number().int().positive().optional(),
    })
    .optional(),
});
export type RenderFormatInput = z.infer<typeof RenderFormatInput>;

/** The rendered, stored export; bytes stay in the object store under the tenant-prefixed key. */
export const RenderFormatResult = z.object({
  pageId: z.string(),
  formatKey: z.string(),
  storageKey: z.string(),
  contentHash: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.string(),
  findings: z.array(Finding),
});
export type RenderFormatResult = z.infer<typeof RenderFormatResult>;

export const RenderStoreInput = RenderJobInputV1.extend({
  brandId: z.string(),
  export: RenderFormatResult,
});
export type RenderStoreInput = z.infer<typeof RenderStoreInput>;

/** storeExport re-reads the object and confirms it hashes to what was rendered: the export row is evidence. */
export const RenderStoreResult = z.object({
  storageKey: z.string(),
  contentHash: z.string().length(64),
  bytes: z.number().int().nonnegative(),
});
export type RenderStoreResult = z.infer<typeof RenderStoreResult>;

export const RenderCompleteInput = RenderJobInputV1.extend({
  rendererVersion: z.string(),
  manifest: RenderManifest,
  exports: z.array(RenderFormatResult).min(1),
});
export type RenderCompleteInput = z.infer<typeof RenderCompleteInput>;

export const RenderCompleteResult = z.object({ exportIds: z.array(z.string()) });
export type RenderCompleteResult = z.infer<typeof RenderCompleteResult>;

export const RenderFailInput = RenderJobInputV1.extend({
  reason: RenderFailureReason,
  detail: z.string().max(1500).optional(),
});
export type RenderFailInput = z.infer<typeof RenderFailInput>;

/**
 * The activity surface of renderJobWorkflowV1. Every activity re-establishes tenant context from the input and
 * re-loads the actor's grants (spec 5.2); renderFormat runs once per (page, format) so a slow format is retried
 * alone; storeExport verifies the stored bytes; completeRender and failRender move the job through the render job
 * state machine (spec 13.1) via the creative module, never by writing a state string.
 */
export interface RenderJobActivitiesV1 {
  beginRender(input: RenderJobInputV1): Promise<RenderBeginResult>;
  resolveRenderInputs(input: RenderResolveInput): Promise<RenderResolveResult>;
  renderFormat(input: RenderFormatInput): Promise<RenderFormatResult>;
  storeExport(input: RenderStoreInput): Promise<RenderStoreResult>;
  completeRender(input: RenderCompleteInput): Promise<RenderCompleteResult>;
  failRender(input: RenderFailInput): Promise<void>;
}
