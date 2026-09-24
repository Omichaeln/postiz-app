import { describe, expect, it } from 'vitest';
import type {
  BrandChangeImpactActivitiesV1,
  BrandChangeImpactInputV1,
} from '@oremedia/contracts/brand-change-impact';
import { runBrandChangeImpact } from './brand-change-impact.workflow.v1';

const base = {
  tenantId: 'ten_A',
  actor: { kind: 'user' as const, id: 'usr_1' },
  correlationId: 'corr_brand_change',
  brandId: 'brd_1',
};
const published: BrandChangeImpactInputV1 = {
  ...base,
  change: { kind: 'version_published', brandVersionId: 'bv_2' },
};
const revoked: BrandChangeImpactInputV1 = { ...base, change: { kind: 'fact_revoked', factId: 'fct_1' } };

/** Fake activities: every step succeeds unless overridden; every call is recorded in order. */
function fakes(overrides: Partial<BrandChangeImpactActivitiesV1> = {}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const rec = <K extends keyof BrandChangeImpactActivitiesV1>(
    name: K,
    impl: BrandChangeImpactActivitiesV1[K],
  ) =>
    (async (arg: never) => {
      calls.push({ name, input: arg });
      return (impl as (a: never) => unknown)(arg);
    }) as BrandChangeImpactActivitiesV1[K];
  const impl: BrandChangeImpactActivitiesV1 = {
    invalidateApprovals: async () => ({ approvalsInvalidated: 2, requestsStaled: 1 }),
    reevaluateScheduledPublications: async () => ({ held: ['pub_1'], unchanged: ['pub_2'] }),
    applyFactRevocation: async () => ({ hold: true, held: ['pub_1'], flagged: [], unchanged: [] }),
    ...overrides,
  };
  const acts: BrandChangeImpactActivitiesV1 = {
    invalidateApprovals: rec('invalidateApprovals', impl.invalidateApprovals),
    reevaluateScheduledPublications: rec(
      'reevaluateScheduledPublications',
      impl.reevaluateScheduledPublications,
    ),
    applyFactRevocation: rec('applyFactRevocation', impl.applyFactRevocation),
  };
  return { acts, calls };
}

describe('brandChangeImpactWorkflowV1 orchestration (spec 8.2)', () => {
  it('a published version invalidates approvals, then re-evaluates every scheduled publication', async () => {
    const { acts, calls } = fakes();
    const result = await runBrandChangeImpact(acts, published);
    expect(calls.map((c) => c.name)).toEqual(['invalidateApprovals', 'reevaluateScheduledPublications']);
    expect(calls[1]!.input).toEqual(published);
    expect(result).toEqual({
      approvalsInvalidated: 2,
      requestsStaled: 1,
      publicationsHeld: 1,
      publicationsFlagged: 0,
      publicationsUnchanged: 1,
    });
  });

  it('a revoked fact invalidates approvals, then applies the revocation with the fact id (never the brand-wide re-evaluation)', async () => {
    const { acts, calls } = fakes({
      applyFactRevocation: async () => ({
        hold: false,
        held: [],
        flagged: ['pub_3', 'pub_4'],
        unchanged: [],
      }),
    });
    const result = await runBrandChangeImpact(acts, revoked);
    expect(calls.map((c) => c.name)).toEqual(['invalidateApprovals', 'applyFactRevocation']);
    expect(calls[1]!.input).toEqual({ ...revoked, factId: 'fct_1' });
    expect(result).toMatchObject({ publicationsHeld: 0, publicationsFlagged: 2, publicationsUnchanged: 0 });
  });

  it('an activity failure propagates (Temporal retries or fails the run; nothing is swallowed)', async () => {
    const { acts, calls } = fakes({
      invalidateApprovals: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(runBrandChangeImpact(acts, published)).rejects.toThrow('database unavailable');
    expect(calls.map((c) => c.name)).toEqual(['invalidateApprovals']);
  });
});
