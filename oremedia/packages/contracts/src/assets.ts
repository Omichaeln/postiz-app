import { z } from 'zod';

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
  purpose: z.enum(['creative', 'logo', 'font', 'reference']),
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
