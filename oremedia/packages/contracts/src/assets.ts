import { z } from 'zod';
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';

export const AssetKind = z.enum([
  'logo',
  'photo',
  'icon',
  'illustration',
  'font',
  'video',
  'audio',
  'template',
  'reference',
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetState = z.enum(['pending_review', 'approved', 'rejected', 'retired']);
export type AssetState = z.infer<typeof AssetState>;

export const UploadIntentState = z.enum(['issued', 'uploaded', 'quarantined', 'accepted', 'rejected']);
export type UploadIntentState = z.infer<typeof UploadIntentState>;

export const AssetPurpose = z.enum(['creative', 'logo', 'font', 'reference']);
export type AssetPurpose = z.infer<typeof AssetPurpose>;

/** Licence and identity metadata parsed from a font file at ingest (spec 9.1 step 4). */
export const FontMetadata = z.object({
  family: z.string().max(200).nullable(),
  subfamily: z.string().max(200).nullable(),
  postscriptName: z.string().max(200).nullable(),
  copyright: z.string().max(500).nullable(),
  licence: z.string().max(500).nullable(),
  licenceUrl: z.string().max(500).nullable(),
  fontVersion: z.string().max(100).nullable(),
  glyphs: z.number().int().nonnegative(),
});
export type FontMetadata = z.infer<typeof FontMetadata>;

/** Spec 9.1: accepted kinds and caps (recommended defaults). */
export const UPLOAD_CAPS_BYTES: Record<string, number> = {
  image: 50 * 1024 * 1024,
  svg: 2 * 1024 * 1024,
  font: 10 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
};

export const ACCEPTED_MIMES: Record<string, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'],
  svg: ['image/svg+xml'],
  font: [
    'font/otf',
    'font/ttf',
    'font/woff2',
    'application/font-sfnt',
    'application/x-font-ttf',
    'application/x-font-otf',
  ],
  video: ['video/mp4', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/mp4'],
  pdf: ['application/pdf'],
};

export const Provenance = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upload'),
    uploadedByUserId: z.string(),
    originalFilename: z.string().max(255),
    /** Recorded by the ingest pipeline: what the file itself declared (fonts) and whether it was sanitised. */
    fontMetadata: FontMetadata.optional(),
    sanitised: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('generated'),
    model: z.string(),
    promptHash: z.string(),
    inputs: z.array(z.string()),
    agentRunId: z.string().optional(),
  }),
  z.object({ kind: z.literal('derived'), fromAssetVersionId: z.string(), transform: z.string() }),
  z.object({ kind: z.literal('imported'), source: z.string(), externalRef: z.string() }),
]);
export type Provenance = z.infer<typeof Provenance>;

export const UsageRightsInput = z.object({
  assetId: z.string(),
  owner: z.string().max(200),
  licenceRef: z.string().max(500).optional(),
  permittedChannels: z.union([z.literal('all'), z.array(z.string()).max(50)]),
  territories: z.union([z.literal('all'), z.array(z.string()).max(100)]),
  expiresAt: z.string().datetime().optional(),
  releases: z.array(z.object({ kind: z.enum(['model', 'property', 'talent']), ref: z.string() })).default([]),
  restrictions: z.array(z.string().max(200)).default([]),
});

export const UploadIntentCreate = z.object({
  brandId: z.string(),
  kind: AssetKind,
  declaredMime: z.string().max(100),
  declaredBytes: z.number().int().positive(),
  originalFilename: z.string().max(255),
});

export const EligibilityQuery = z.object({
  brandId: z.string(),
  purpose: AssetPurpose,
  channelConnectionIds: z.array(z.string()).max(50).default([]),
  territory: z.string().optional(),
  scheduledFor: z.string().datetime().optional(),
  kinds: z.array(AssetKind).optional(),
  query: z.string().max(200).optional(),
});
export type EligibilityQuery = z.infer<typeof EligibilityQuery>;

export interface AssetRef {
  assetId: string;
  assetVersionId: string;
  kind: AssetKind;
  semanticRole: string | null;
  altText: string | null;
  contentHash: string;
  width: number | null;
  height: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2 asset library DTOs (spec 7.5 assets router, 9.1 ingestion, 9.2 eligibility, 9.3 delivery).
// ---------------------------------------------------------------------------------------------------------------

export const MimeGroup = z.enum(['image', 'svg', 'font', 'video', 'audio', 'pdf']);
export type MimeGroup = z.infer<typeof MimeGroup>;

/** Which mime groups each asset kind may be uploaded as (spec 9.1 accepted kinds). */
export const KIND_MIME_GROUPS: Readonly<Record<AssetKind, readonly MimeGroup[]>> = {
  logo: ['svg', 'image'],
  photo: ['image'],
  icon: ['svg', 'image'],
  illustration: ['svg', 'image'],
  font: ['font'],
  video: ['video'],
  audio: ['audio'],
  template: ['image', 'svg', 'pdf'],
  reference: ['image', 'svg', 'pdf'],
};

/** Kinds whose processing arrives in Release 2 (spec 9.1): intents for them are refused, not queued. */
export const KINDS_NOT_PROCESSABLE: readonly AssetKind[] = ['video', 'audio'];

/** Archives are rejected in Release 1 (spec 9.1); named explicitly so the rejection reason is specific. */
export const ARCHIVE_MIMES: readonly string[] = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/java-archive',
];

/** Spec 9.2: rights must outlive the scheduled time plus the provider processing window. */
export const RIGHTS_PROCESSING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Spec 9.3: the web app receives 5-minute signed URLs. */
export const SIGNED_URL_TTL_SEC = 5 * 60;
/** A presigned PUT is valid for one hour; an intent not completed by then expires. */
export const UPLOAD_INTENT_TTL_SEC = 60 * 60;
/** Header-declared pixel budget for raster images: checked before any decode (decompression bombs, spec 18). */
export const MAX_IMAGE_PIXELS = 64_000_000;

/** Kinds compatible with each purpose (spec 9.2 "kind compatible with :purpose"). */
export const PURPOSE_KINDS: Readonly<Record<AssetPurpose, readonly AssetKind[]>> = {
  logo: ['logo'],
  font: ['font'],
  creative: ['photo', 'illustration', 'icon', 'logo'],
  reference: AssetKind.options,
};

/** Purposes that require recorded usage rights; 'unknown' rights make an asset ineligible for them. */
export const PURPOSES_REQUIRING_RIGHTS: readonly AssetPurpose[] = ['creative', 'logo'];

export const DerivativePurpose = z.enum(['thumbnail', 'preview', 'web']);
export type DerivativePurpose = z.infer<typeof DerivativePurpose>;

export const UploadIntentComplete = z.object({ intentId: z.string() });

export const AssetGet = z.object({ assetId: z.string() });

export const AssetVersionsList = z.object({ assetId: z.string(), page: PageRequest });

export const AssetSearch = z.object({ query: EligibilityQuery, page: PageRequest });

export const AssetApprove = z.object({
  assetId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});

export const AssetRetire = z.object({
  assetId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().max(200).optional(),
});

export const AssetUsagesList = z.object({ assetId: z.string(), page: PageRequest });

export const AssetGrantCreate = z.object({
  assetId: z.string(),
  granteeBrandId: z.string(),
  purpose: AssetPurpose,
  expiresAt: z.string().datetime().optional(),
});

/** Spec 9.3: a short-lived signed GET for the original or one derivative of a version. */
export const MediaSignedUrlRequest = z.object({
  assetVersionId: z.string(),
  derivative: z.union([z.literal('original'), DerivativePurpose]).default('preview'),
});

/** Spec 9.2 reasons an asset is not eligible; `authoriseUse` surfaces them in RIGHTS_INELIGIBLE. */
export const EligibilityReason = z.enum([
  'state_not_approved',
  'brand_not_permitted',
  'kind_incompatible',
  'rights_unknown',
  'rights_expired',
  'channel_not_permitted',
  'territory_not_permitted',
]);
export type EligibilityReason = z.infer<typeof EligibilityReason>;

/** Spec 9.1 rejection codes. Rejections are values, never exceptions (steps.ts). */
export const IngestRejectionReason = z.enum([
  'object_missing',
  'exceeds_cap',
  'type_unrecognised',
  'type_mismatch',
  'declared_mime_mismatch',
  'archive_rejected',
  'malware_detected',
  'scanner_unavailable',
  'svg_unparsable',
  'svg_unsafe_content',
  'svg_unrenderable',
  'font_unparsable',
  'font_collection_unsupported',
  'pixel_limit_exceeded',
  'image_undecodable',
  'format_unsupported',
  'duplicate_of',
]);
export type IngestRejectionReason = z.infer<typeof IngestRejectionReason>;

export interface IngestStepRejection {
  ok: false;
  reason: IngestRejectionReason;
  /** Short, user-safe detail (never raw parser output). */
  detail?: string;
  /** Set with reason 'duplicate_of': the existing asset the uploader is invited to link instead. */
  duplicateOfAssetId?: string;
  /** Infrastructure failure (scanner unreachable): the activity retries; the intent stays quarantined. */
  retryable?: boolean;
}
export type IngestStepResult<T extends object> = ({ ok: true } & T) | IngestStepRejection;

export interface IngestDerivativeRef {
  purpose: DerivativePurpose;
  key: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  contentHash: string;
  transform: Record<string, string | number | boolean>;
}

// --- assetIngestWorkflowV1 contract (workflows import only contracts) ---------------------------------------

/** Every activity input carries the tenant context (spec 5.2) plus the intent; activities re-load the rest. */
export const AssetIngestInputV1 = TenantContextInput.extend({ intentId: z.string(), brandId: z.string() });
export type AssetIngestInputV1 = z.infer<typeof AssetIngestInputV1>;

export type AssetIngestOutcome = 'accepted' | 'rejected' | 'quarantined';

export type AssetIngestResultV1 =
  | { outcome: 'accepted'; assetId: string; assetVersionId: string; state: AssetState }
  | { outcome: 'rejected'; reason: IngestRejectionReason; duplicateOfAssetId?: string }
  | { outcome: 'quarantined'; reason: IngestRejectionReason };

export interface IngestBeginResult {
  intentId: string;
  brandId: string;
  kind: AssetKind;
  declaredMime: string;
  maxBytes: number;
  storageKey: string;
}
export interface IngestVerifyResult {
  bytes: number;
}
export interface IngestSniffResult {
  mime: string;
  group: MimeGroup;
}
export interface IngestScanResult {
  engine: string;
}
export interface IngestSanitiseResult {
  sanitisedKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  colourProfile: string | null;
  fontMetadata?: FontMetadata;
  /** Rasterised PNG of a sanitised SVG, used as the source of its derivatives. */
  previewKey?: string;
  sanitised: boolean;
}
export interface IngestHashResult {
  contentHash: string;
}
export interface IngestDerivativesResult {
  derivatives: IngestDerivativeRef[];
}
export interface IngestMoveResult {
  assetId: string;
  assetVersionId: string;
  originalKey: string;
  derivatives: IngestDerivativeRef[];
}
export interface IngestCatalogueResult {
  assetId: string;
  assetVersionId: string;
  state: AssetState;
}

export type IngestSanitiseInput = AssetIngestInputV1 & { mime: string; group: MimeGroup };
export type IngestHashInput = AssetIngestInputV1 & { sanitisedKey: string };
export type IngestDerivativesInput = AssetIngestInputV1 & {
  sanitisedKey: string;
  mime: string;
  group: MimeGroup;
  previewKey?: string;
};
export type IngestMoveInput = AssetIngestInputV1 & {
  sanitisedKey: string;
  derivatives: IngestDerivativeRef[];
};
export type IngestCatalogueInput = AssetIngestInputV1 & {
  assetId: string;
  assetVersionId: string;
  originalKey: string;
  contentHash: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  colourProfile: string | null;
  fontMetadata?: FontMetadata;
  sanitised: boolean;
  derivatives: IngestDerivativeRef[];
};
export type IngestFinaliseInput = AssetIngestInputV1 & {
  outcome: AssetIngestOutcome;
  reason?: IngestRejectionReason;
  duplicateOfAssetId?: string;
  /** Quarantine-prefixed keys to delete; the activity refuses anything outside quarantine/{tenant}/. */
  cleanupKeys: string[];
};

/**
 * The activity surface of assetIngestWorkflowV1 (spec 9.1 steps 1–8). Activity parameters are frozen once
 * deployed: a change ships as a new interface version and a new workflow version.
 */
export interface AssetIngestActivitiesV1 {
  beginIngest(input: AssetIngestInputV1): Promise<IngestBeginResult>;
  verifyUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestVerifyResult>>;
  sniffUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestSniffResult>>;
  scanUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestScanResult>>;
  sanitiseUpload(input: IngestSanitiseInput): Promise<IngestStepResult<IngestSanitiseResult>>;
  hashUpload(input: IngestHashInput): Promise<IngestStepResult<IngestHashResult>>;
  buildDerivatives(input: IngestDerivativesInput): Promise<IngestStepResult<IngestDerivativesResult>>;
  moveToImmutable(input: IngestMoveInput): Promise<IngestMoveResult>;
  catalogueAsset(input: IngestCatalogueInput): Promise<IngestCatalogueResult>;
  finaliseUpload(input: IngestFinaliseInput): Promise<void>;
}
