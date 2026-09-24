import { z } from 'zod';

export const ContentRevisionState = z.enum([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'superseded',
]);
export type ContentRevisionState = z.infer<typeof ContentRevisionState>;

export const ReviewRequestState = z.enum(['open', 'stale', 'decided', 'cancelled']);
export type ReviewRequestState = z.infer<typeof ReviewRequestState>;

export const ReviewDecisionKind = z.enum(['approve', 'request_changes', 'reject']);
export type ReviewDecisionKind = z.infer<typeof ReviewDecisionKind>;

/** Spec 13.3: frozen manifest of exactly what the reviewer sees. */
export const FrozenManifestV1 = z.object({
  v: z.literal(1),
  contentRevisionId: z.string(),
  contentHash: z.string(),
  creativeRevisionIds: z.array(z.string()),
  exports: z.array(
    z.object({ exportId: z.string(), contentHash: z.string(), channelConnectionId: z.string() }),
  ),
  captions: z.array(
    z.object({
      channelConnectionId: z.string(),
      text: z.string(),
      altTexts: z.array(z.string()),
      settingsHash: z.string(),
    }),
  ),
  timing: z.union([
    z.object({ kind: z.literal('exact'), at: z.string().datetime() }),
    z.object({ kind: z.literal('window'), from: z.string().datetime(), to: z.string().datetime() }),
  ]),
  brandVersionId: z.string(),
  policyVersionId: z.string(),
});
export type FrozenManifestV1 = z.infer<typeof FrozenManifestV1>;

export const ReviewRequestCreate = z.object({
  contentRevisionId: z.string(),
  assigneeUserIds: z.array(z.string()).max(20).default([]),
  dueAt: z.string().datetime().optional(),
  timing: FrozenManifestV1.shape.timing,
});

export const ReviewDecisionSubmit = z.object({
  reviewRequestId: z.string(),
  decision: ReviewDecisionKind,
  comment: z.string().max(4000).optional(),
  expectedManifestHash: z.string(),
  validUntil: z.string().datetime().optional(),
});

export interface Check {
  key: string;
  ok: boolean;
}

export type ReleaseDecision = { allow: true } | { allow: false; hold: true; reasons: string[] };

// ---------------------------------------------------------------------------------------------------------------
// Phase 5 review module (spec 7.5 `review` router, 13.2–13.4). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';
import type { ApprovalBindingV1 } from './approval';
import { MandateState } from './publishing';

export const ReviewRequestGet = z.object({ reviewRequestId: z.string() });
export const ReviewInboxList = z.object({ brandId: z.string().optional(), page: PageRequest });
export const ApprovalGet = z.object({ approvalId: z.string() });

export const MandateGet = z.object({ mandateId: z.string() });
export const MandatePause = z.object({ mandateId: z.string(), expectedVersion: z.number().int() });
export const MandateRevoke = z.object({
  mandateId: z.string(),
  expectedVersion: z.number().int(),
  reason: z.string().max(500).optional(),
});
export { MandateState };

/** Why an open request went stale (spec 13.3: reviewers are told why). */
export const StaleReason = z.enum([
  'package_revised',
  'variant_changed',
  'creative_changed',
  'brand_changed',
]);
export type StaleReason = z.infer<typeof StaleReason>;

/** Why a valid approval was invalidated eagerly (spec 13.2: UX only; dispatch recomputes the binding). */
export const ApprovalInvalidatedReason = z.enum([
  'content_revision_changed',
  'creative_revision_changed',
  'brand_changed',
  'request_cancelled',
]);
export type ApprovalInvalidatedReason = z.infer<typeof ApprovalInvalidatedReason>;

/** The attention an inbox item needs (spec 21.2 review inbox required states). */
export const InboxAttention = z.enum([
  'awaiting_decision',
  'stale',
  'changes_requested',
  'approved',
  'approval_invalidated',
  'external_access_revoked',
]);
export type InboxAttention = z.infer<typeof InboxAttention>;

/** The live binding (spec 13.4 buildLiveBinding) with the rows it was computed from, for callers that need both. */
export interface LiveBinding {
  binding: ApprovalBindingV1;
  bindingHash: string;
}

export const RELEASE_CHECK_KEYS = [
  'approval_valid',
  'approval_matches',
  'approval_not_expired',
  'approver_still_authorised',
  'timing_within_binding',
  'mandate_active',
  'mandate_channel',
  'mandate_content_class',
  'mandate_daily_quota',
  'mandate_sources',
  'owner_still_authorised',
  'kill_switch_off',
  'brand_review_clean',
  'channel_active',
  'assets_rights_valid',
  'facts_valid',
  'capability_valid',
] as const;
export type ReleaseCheckKey = (typeof RELEASE_CHECK_KEYS)[number];
