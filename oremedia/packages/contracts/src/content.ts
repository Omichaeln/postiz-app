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
  /** Spec 16.4: a brief created by accepting a recommendation carries the back-reference for the learning record. */
  recommendationId: z.string().optional(),
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

// ---------------------------------------------------------------------------------------------------------------
// Phase 5 content module (spec 7.5 `content` router, 6.3 content tables). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';

export const CampaignList = z.object({ brandId: z.string(), page: PageRequest });
export const CampaignGet = z.object({ campaignId: z.string() });

export const BriefList = z.object({
  brandId: z.string(),
  campaignId: z.string().optional(),
  page: PageRequest,
});
export const BriefGet = z.object({ briefId: z.string() });
export const BriefAccept = z.object({ briefId: z.string(), expectedVersion: z.number().int() });

/**
 * A package is born with content revision 1: the master copy (spec 6.3 content_revisions.copy) and the creative
 * documents it publishes with. The revision pins those documents' *current* creative revisions and the brand's
 * published version and active policy version at creation time.
 */
export const ContentPackageCreate = z.object({
  brandId: z.string(),
  briefId: z.string().optional(),
  title: z.string().min(1).max(200),
  copy: CopyDocumentV1,
  creativeDocumentIds: z.array(z.string()).max(20).default([]),
});
/** A revision is never edited: revising creates content revision n+1 and supersedes the current one (spec 13.1). */
export const ContentPackageRevise = z.object({
  contentPackageId: z.string(),
  expectedVersion: z.number().int(),
  copy: CopyDocumentV1,
  creativeDocumentIds: z.array(z.string()).max(20).default([]),
  summary: z.string().max(500).optional(),
});
export const ContentPackageGet = z.object({ contentPackageId: z.string() });
export const ContentPackageList = z.object({ brandId: z.string(), page: PageRequest });
export const ContentRevisionGet = z.object({ revisionId: z.string() });

/** One variant per (content revision, channel connection); existing targets are returned, never duplicated. */
export const ChannelVariantGenerate = z.object({
  contentRevisionId: z.string(),
  channelConnectionIds: z.array(z.string()).min(1).max(20),
});
export const ChannelVariantGet = z.object({ variantId: z.string() });

export const CalendarRange = z.object({
  brandId: z.string(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/** What a calendar shows for a publication; supplied by the publishing module through the content module's calendar source hook. */
export interface CalendarPublication {
  publicationId: string;
  contentPackageId: string;
  contentRevisionId: string;
  channelVariantId: string;
  channelConnectionId: string;
  scheduledFor: string;
  state: string;
}

/** A content revision's brand-review class (spec 13.4 mandate_content_class, 8.1 requireReviewForContentClasses). */
export const ContentClass = z.enum(['general', 'offer']);
export type ContentClass = z.infer<typeof ContentClass>;
