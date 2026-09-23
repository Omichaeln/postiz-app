import { z } from 'zod';

export const InsightKind = z.enum(['change', 'anomaly', 'association', 'experimental_finding']);
export const EvidenceStrength = z.enum(['observed', 'directional', 'experimentally_supported']);
export type EvidenceStrength = z.infer<typeof EvidenceStrength>;
export const InsightState = z.enum(['active', 'superseded', 'dismissed']);

export const RecommendationAction = z.enum([
  'create_brief',
  'generate_variants',
  'open_canvas',
  'prepare_test',
  'assign_response',
  'propose_playbook_update',
]);
export type RecommendationAction = z.infer<typeof RecommendationAction>;
export const RecommendationState = z.enum(['proposed', 'accepted', 'dismissed', 'executed']);

export const LearningVerdict = z.enum(['supported', 'not_supported', 'inconclusive', 'pending']);
export const PlaybookState = z.enum(['proposed', 'approved', 'retired']);
export const VoiceClusterKind = z.enum(['question', 'objection', 'praise', 'need', 'complaint']);
export const MessageClassification = z.enum([
  'question',
  'objection',
  'praise',
  'need',
  'complaint',
  'spam',
  'other',
]);
export const ListeningSourceKind = z.enum(['keyword', 'competitor_account', 'rss', 'subreddit']);
export const AnomalyState = z.enum(['open', 'acknowledged', 'resolved']);

export const RecommendationDecide = z.object({
  recommendationId: z.string(),
  expectedVersion: z.number().int(),
  action: z.union([RecommendationAction, z.literal('dismiss')]),
  dismissalReason: z.string().max(500).optional(),
});

export const PlaybookPropose = z.object({
  brandId: z.string(),
  practice: z.string().min(1).max(2000),
  evidenceInsightIds: z.array(z.string()).min(1).max(50),
  strength: EvidenceStrength,
  reviewAfter: z.string().datetime(),
});

/** Spec 16.1: coverage statement always shown next to listening outputs. */
export const CoverageStatement = z.object({
  sources: z.array(z.string()),
  competitors: z.array(z.string()),
  languages: z.array(z.string()),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});
