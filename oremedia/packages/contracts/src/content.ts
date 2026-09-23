import { z } from 'zod';

export const CampaignState = z.enum(['draft', 'active', 'completed', 'archived']);
export const BriefState = z.enum(['draft', 'accepted', 'in_progress', 'delivered', 'cancelled']);
export const ContentPackageState = z.enum([
  'draft',
  'in_review',
  'approved',
  'scheduled',
  'published',
  'archived',
]);

export const CopyDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  master: z.object({ text: z.string().max(10000), factRefs: z.array(z.string()).default([]) }),
  rationale: z.string().max(2000).optional(),
});
export type CopyDocumentV1 = z.infer<typeof CopyDocumentV1>;

export const BriefCreate = z.object({
  brandId: z.string(),
  campaignId: z.string().optional(),
  audience: z.string().max(1000),
  message: z.string().max(2000),
  offerFactIds: z.array(z.string()).max(20).default([]),
  channelConnectionIds: z.array(z.string()).max(20).default([]),
  constraints: z.array(z.string().max(300)).max(20).default([]),
});

export const CampaignCreate = z.object({
  brandId: z.string(),
  objectiveId: z.string().optional(),
  name: z.string().min(1).max(200),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export const ChannelVariantUpdate = z.object({
  channelVariantId: z.string(),
  expectedVersion: z.number().int(),
  text: z.string().max(10000),
  altTexts: z.array(z.string().max(1000)).max(20),
  settings: z.record(z.unknown()),
  exportIds: z.array(z.string()).max(20),
});

export const CreativeAttributeSource = z.enum(['captured', 'human_corrected', 'inferred']);
export const ImageryKind = z.enum(['people', 'product', 'illustration', 'photography', 'none']);

export const CreativeAttributesV1 = z.object({
  hookType: z.string().max(80).optional(),
  topic: z.string().max(120).optional(),
  message: z.string().max(300).optional(),
  offerFactId: z.string().optional(),
  cta: z.string().max(120).optional(),
  templateVersionId: z.string().optional(),
  layoutKey: z.string().max(80).optional(),
  colourTreatment: z.string().max(80).optional(),
  typographyRoles: z.array(z.string()).optional(),
  imageryKind: ImageryKind.optional(),
  videoOpening: z.string().max(120).optional(),
  durationMs: z.number().int().optional(),
  subtitles: z.boolean().optional(),
  pacing: z.string().max(40).optional(),
  distribution: z.string().max(40).optional(),
});
export type CreativeAttributesV1 = z.infer<typeof CreativeAttributesV1>;
