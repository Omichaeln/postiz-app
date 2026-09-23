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
