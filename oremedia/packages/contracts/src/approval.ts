import { z } from 'zod';

/** Spec 13.2: approval binds to exactly what was approved. Hash = sha256(canonicalJson(binding)). */
export const ApprovalBindingV1 = z.object({
  v: z.literal(1),
  tenantId: z.string(),
  brandId: z.string(),
  contentRevisionId: z.string(),
  brandVersionId: z.string(),
  policyVersionId: z.string(),
  targets: z
    .array(
      z.object({
        channelConnectionId: z.string(),
        textHash: z.string(), // exact caption, normalised (NFC, trimmed trailing whitespace)
        altTextHashes: z.array(z.string()),
        settingsHash: z.string(), // provider settings, canonical JSON
        exportHashes: z.array(z.string()), // exact rendered files, in order
      }),
    )
    .min(1),
  timing: z.union([
    z.object({ kind: z.literal('exact'), at: z.string().datetime() }),
    z.object({ kind: z.literal('window'), from: z.string().datetime(), to: z.string().datetime() }),
  ]),
});
export type ApprovalBindingV1 = z.infer<typeof ApprovalBindingV1>;

export const ApprovalState = z.enum(['valid', 'invalidated', 'consumed', 'expired']);
export type ApprovalState = z.infer<typeof ApprovalState>;
