import { z } from 'zod';
import { PageRequest } from './pagination';

/** Spec 8.1: the brand system document, versioned. */
export const BrandSystemDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  voice: z.object({
    summary: z.string().max(2000),
    tone: z.array(z.string()).max(12),
    audiences: z.array(z.object({ key: z.string(), description: z.string() })),
    preferredTerms: z.array(z.object({ use: z.string(), avoid: z.array(z.string()) })),
    prohibitedPhrases: z.array(z.string()),
    locales: z.array(z.string()),
    examples: z.array(
      z.object({ text: z.string(), verdict: z.enum(['on_brand', 'off_brand']), note: z.string() }),
    ),
  }),
  tokens: z.object({
    colours: z.array(
      z.object({
        key: z.string(),
        value: z.string(),
        role: z.enum(['primary', 'secondary', 'accent', 'neutral', 'background', 'text', 'semantic']),
      }),
    ),
    typeRoles: z.array(
      z.object({
        role: z.enum(['display', 'heading', 'body', 'label', 'caption']),
        fontAssetId: z.string(),
        weight: z.number(),
        minSizePx: z.number(),
        tracking: z.number().optional(),
      }),
    ),
    spacingScale: z.array(z.number()),
    radii: z.array(z.number()),
    contrastTarget: z.enum(['AA', 'AAA']).default('AA'),
  }),
  logoRules: z.array(
    z.object({
      assetId: z.string(),
      variant: z.enum(['primary', 'reversed', 'mono', 'mark_only']),
      allowedBackgroundColourKeys: z.array(z.string()),
      clearSpaceRatio: z.number(), // multiple of mark height
      minWidthPx: z.number(),
    }),
  ),
  patterns: z.array(
    z.object({
      key: z.string(),
      description: z.string(),
      exampleAssetIds: z.array(z.string()),
      templateVersionIds: z.array(z.string()),
    }),
  ),
  channelGuidance: z.array(
    z.object({
      providerKey: z.string(),
      captionStyle: z.string(),
      preferredFormats: z.array(z.string()),
      ctaConventions: z.string(),
    }),
  ),
});
export type BrandSystemDocumentV1 = z.infer<typeof BrandSystemDocumentV1>;

/** A draft with no published predecessor starts from this document (spec 8.2). */
export const emptyBrandSystemDocument = (): BrandSystemDocumentV1 => ({
  schemaVersion: 1,
  voice: {
    summary: '',
    tone: [],
    audiences: [],
    preferredTerms: [],
    prohibitedPhrases: [],
    locales: [],
    examples: [],
  },
  tokens: { colours: [], typeRoles: [], spacingScale: [], radii: [], contrastTarget: 'AA' },
  logoRules: [],
  patterns: [],
  channelGuidance: [],
});

export const BrandVersionState = z.enum(['draft', 'in_review', 'published', 'retired']);
export type BrandVersionState = z.infer<typeof BrandVersionState>;

export const BrandStatus = z.enum(['setup', 'active', 'archived']);
export type BrandStatus = z.infer<typeof BrandStatus>;

export const FactKind = z.enum(['product', 'claim', 'offer', 'contact', 'price', 'statistic', 'legal']);
export type FactKind = z.infer<typeof FactKind>;

export const FactState = z.enum(['proposed', 'approved', 'revoked']);
export type FactState = z.infer<typeof FactState>;

export const FactProposedByKind = z.enum(['user', 'agent']);
export type FactProposedByKind = z.infer<typeof FactProposedByKind>;

export const PolicyVersionState = z.enum(['draft', 'active', 'retired']);
export type PolicyVersionState = z.infer<typeof PolicyVersionState>;

/** Evidence behind an approved fact: source document/asset refs, URLs, reviewer. */
export const EvidenceRef = z.object({
  kind: z.enum([
    'asset',
    'document',
    'url',
    'reviewer',
    'metric_snapshot',
    'experiment_result',
    'comment',
    'other',
  ]),
  ref: z.string().max(1000),
  note: z.string().max(500).optional(),
  capturedAt: z.string().datetime().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** Spec 6.3 policy_versions. */
export const PolicyDocumentV1 = z.object({
  schemaVersion: z.literal(1),
  reviewThresholds: z.object({
    requireReviewForContentClasses: z.array(z.string()).default([]),
    blockOnBrandReviewSeverity: z.enum(['blocking', 'warning']).default('blocking'),
  }),
  restrictedTopics: z.array(z.string()).default([]),
  prohibitedTerms: z.array(z.string()).default([]),
  requireDistinctApprover: z.boolean().default(false),
  holdOnDependencyRevocation: z.boolean().default(true), // spec 8.2 default: hold
  mfaRequired: z.boolean().default(false),
});
export type PolicyDocumentV1 = z.infer<typeof PolicyDocumentV1>;

/** The policy in force while a brand has no active policy version: every default, including hold on revocation. */
export const defaultPolicyDocument = (): PolicyDocumentV1 =>
  PolicyDocumentV1.parse({ schemaVersion: 1, reviewThresholds: {} });

export const DesignTokenSetV1 = z.object({
  schemaVersion: z.literal(1),
  colour: z.record(z.string()),
  typeRoles: z.record(z.object({ fontAssetId: z.string(), weight: z.number(), minSizePx: z.number() })),
  spacing: z.array(z.number()),
  radius: z.array(z.number()),
});
export type DesignTokenSetV1 = z.infer<typeof DesignTokenSetV1>;

/**
 * Spec 8.3: immutable, hashed bundle for agents and validation. `hash` is hashCanonical of the bundle without
 * `hash` (packages/domain/src/brand-snapshot.ts). Every agent run and every revision records the hash.
 */
export const BrandSnapshotV1 = z.object({
  hash: z.string().length(64),
  brandId: z.string(),
  brandVersionId: z.string(),
  brandVersionNumber: z.number().int(),
  document: BrandSystemDocumentV1,
  /** Approved facts whose validity window contains the resolution time, sorted by id. */
  facts: z.array(
    z.object({
      id: z.string(),
      kind: FactKind,
      statement: z.string(),
      validFrom: z.string().datetime().nullable(),
      validUntil: z.string().datetime().nullable(),
    }),
  ),
  /** Objectives active at the resolution time, sorted by id. */
  objectives: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      primaryMetricKey: z.string(),
      guardrailMetricKeys: z.array(z.string()),
    }),
  ),
  /** null: no policy version has been activated yet; `policy` is then defaultPolicyDocument(). */
  policyVersionId: z.string().nullable(),
  policy: PolicyDocumentV1,
  /** Supplied by the creative module from Phase 3 (templates); always [] until then. */
  eligibleTemplateVersionIds: z.array(z.string()),
  timezone: z.string(),
  defaultLocale: z.string(),
});
export type BrandSnapshot = z.infer<typeof BrandSnapshotV1>;

// ---- router DTOs ----
export const BrandCreate = z.object({
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64),
  defaultLocale: z.string().min(2).max(16),
});
export const BrandVersionCreateDraft = z.object({ brandId: z.string() });
export const BrandVersionUpdate = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
  document: BrandSystemDocumentV1,
});
export const BrandVersionSubmit = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
});
export const BrandVersionPublish = z.object({
  brandId: z.string(),
  versionId: z.string(),
  expectedVersion: z.number().int(),
});
export const BrandVersionGet = z.object({ brandId: z.string(), versionId: z.string() });
export const BrandVersionList = z.object({ brandId: z.string(), page: PageRequest });
export const FactPropose = z.object({
  brandId: z.string(),
  kind: FactKind,
  statement: z.string().min(1).max(4000),
  evidence: z.array(EvidenceRef).min(1).max(20),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
});
export const FactApprove = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
});
export const FactRevoke = z.object({
  brandId: z.string(),
  factId: z.string(),
  expectedVersion: z.number().int(),
  reason: z.string().max(500).optional(),
});
export const FactList = z.object({ brandId: z.string(), state: FactState.optional(), page: PageRequest });
export const ObjectiveSet = z.object({
  brandId: z.string(),
  name: z.string().min(1).max(160),
  primaryMetricKey: z.string().min(1).max(80),
  guardrailMetricKeys: z.array(z.string().max(80)).max(20),
  engagementQualityWeights: z.record(z.number().min(0).max(10)).optional(),
  activeFrom: z.string().datetime(),
  activeUntil: z.string().datetime().optional(),
});
export const ObjectiveList = z.object({
  brandId: z.string(),
  activeOnly: z.boolean().default(false),
  page: PageRequest,
});
export const PolicyVersionCreate = z.object({ brandId: z.string(), document: PolicyDocumentV1 });
export const PolicyVersionActivate = z.object({
  brandId: z.string(),
  policyVersionId: z.string(),
  expectedVersion: z.number().int(),
});
export const PolicyGet = z.object({ brandId: z.string(), policyVersionId: z.string().optional() });
export const BrandSnapshotResolve = z.object({ brandId: z.string(), versionId: z.string().optional() });
/** Spec 8.2: onboarding is an agent run (Phase 4). The input shape is fixed now so clients can be written against it. */
export const OnboardingStart = z.object({
  brandId: z.string(),
  sourceAssetIds: z.array(z.string()).max(50).default([]),
  websiteUrls: z.array(z.string().url().max(1000)).max(10).default([]),
});
