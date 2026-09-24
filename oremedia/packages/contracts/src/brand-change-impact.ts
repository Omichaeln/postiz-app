import { z } from 'zod';
import { TenantContextInput } from './tenancy';

/**
 * Spec 8.2 brand change impact (ledger 2.9, 2.10): brand.version_published and brand.fact_revoked start
 * brandChangeImpactWorkflowV1 on task queue `core`. Approvals of the brand are invalidated (spec 13.2), every
 * scheduled publication is re-evaluated against the release policy and held with the failed checks, and a revoked
 * fact holds (policy holdOnDependencyRevocation, the default) or flags (needs attention, state unchanged) the
 * scheduled publications whose content revision cites it. Activities re-establish tenant context (spec 5.2) and
 * are idempotent: a second run over the same change finds nothing left to move.
 */
export const BrandChangeV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('version_published'), brandVersionId: z.string() }),
  z.object({ kind: z.literal('fact_revoked'), factId: z.string() }),
]);
export type BrandChangeV1 = z.infer<typeof BrandChangeV1>;

/** Workflow input: references only. The workflow id is stable per outbox event (`brand-change:<eventId>`). */
export const BrandChangeImpactInputV1 = TenantContextInput.extend({
  brandId: z.string(),
  change: BrandChangeV1,
});
export type BrandChangeImpactInputV1 = z.infer<typeof BrandChangeImpactInputV1>;

export const ApprovalsInvalidatedResultV1 = z.object({
  approvalsInvalidated: z.number().int().nonnegative(),
  requestsStaled: z.number().int().nonnegative(),
});
export type ApprovalsInvalidatedResultV1 = z.infer<typeof ApprovalsInvalidatedResultV1>;

/** Publication ids moved to `held` (with the failed checks as reasons) and those the release policy still allows. */
export const PublicationsReevaluatedResultV1 = z.object({
  held: z.array(z.string()),
  unchanged: z.array(z.string()),
});
export type PublicationsReevaluatedResultV1 = z.infer<typeof PublicationsReevaluatedResultV1>;

export const FactRevocationInputV1 = BrandChangeImpactInputV1.extend({ factId: z.string() });
export type FactRevocationInputV1 = z.infer<typeof FactRevocationInputV1>;

/** hold: the brand's policy at the time of the run; flagged publications keep their state (needs attention). */
export const FactRevocationResultV1 = z.object({
  hold: z.boolean(),
  held: z.array(z.string()),
  flagged: z.array(z.string()),
  unchanged: z.array(z.string()),
});
export type FactRevocationResultV1 = z.infer<typeof FactRevocationResultV1>;

export const BrandChangeImpactResultV1 = z.object({
  approvalsInvalidated: z.number().int().nonnegative(),
  requestsStaled: z.number().int().nonnegative(),
  publicationsHeld: z.number().int().nonnegative(),
  publicationsFlagged: z.number().int().nonnegative(),
  publicationsUnchanged: z.number().int().nonnegative(),
});
export type BrandChangeImpactResultV1 = z.infer<typeof BrandChangeImpactResultV1>;

/**
 * The effects behind the activities, composed by worker-core from the review, content and publishing modules
 * (apps/worker-core/src/brand-change-runtime.ts), as the publishing runtime is for publish-control. Each call runs
 * in the tenant context the activity established and in one transaction.
 */
export interface BrandChangeImpactRuntimeV1 {
  invalidateApprovals(brandId: string): Promise<ApprovalsInvalidatedResultV1>;
  reevaluateScheduledPublications(brandId: string, reason: string): Promise<PublicationsReevaluatedResultV1>;
  applyFactRevocation(brandId: string, factId: string): Promise<FactRevocationResultV1>;
}

/** The activity surface of brandChangeImpactWorkflowV1 (packages/activities/src/brand-change-impact.ts). */
export interface BrandChangeImpactActivitiesV1 {
  invalidateApprovals(input: BrandChangeImpactInputV1): Promise<ApprovalsInvalidatedResultV1>;
  reevaluateScheduledPublications(input: BrandChangeImpactInputV1): Promise<PublicationsReevaluatedResultV1>;
  applyFactRevocation(input: FactRevocationInputV1): Promise<FactRevocationResultV1>;
}
