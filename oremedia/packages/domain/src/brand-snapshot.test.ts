import { describe, expect, it } from 'vitest';
import { defaultPolicyDocument, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { buildBrandSnapshot, verifyBrandSnapshot, type BrandSnapshotBundle } from './brand-snapshot';

const base = (): BrandSnapshotBundle => ({
  brandId: 'brd_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  brandVersionId: 'bv_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  brandVersionNumber: 3,
  document: {
    ...emptyBrandSystemDocument(),
    voice: { ...emptyBrandSystemDocument().voice, summary: 'Plain and confident', tone: ['plain'] },
  },
  facts: [
    {
      id: 'fact_01HZZZZZZZZZZZZZZZZZZZZZZB',
      kind: 'offer',
      statement: '20% off in October',
      validFrom: '2026-10-01T00:00:00.000Z',
      validUntil: '2026-10-31T23:59:59.000Z',
    },
    {
      id: 'fact_01HZZZZZZZZZZZZZZZZZZZZZZA',
      kind: 'claim',
      statement: 'Made in Harare',
      validFrom: null,
      validUntil: null,
    },
  ],
  objectives: [
    {
      id: 'obj_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      name: 'Enquiries',
      primaryMetricKey: 'qualified_enquiries',
      guardrailMetricKeys: ['unfollows'],
    },
  ],
  policyVersionId: 'pol_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  policy: { ...defaultPolicyDocument(), prohibitedTerms: ['cheap'] },
  eligibleTemplateVersionIds: [],
  timezone: 'Africa/Harare',
  defaultLocale: 'en',
});

describe('buildBrandSnapshot (spec 8.3)', () => {
  it('is deterministic: the same input twice gives the same hash', () => {
    const a = buildBrandSnapshot(base());
    const b = buildBrandSnapshot(base());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toEqual(b);
  });

  it('is independent of key order and of row order', () => {
    const input = base();
    const reordered: BrandSnapshotBundle = {
      defaultLocale: input.defaultLocale,
      timezone: input.timezone,
      eligibleTemplateVersionIds: input.eligibleTemplateVersionIds,
      policy: input.policy,
      policyVersionId: input.policyVersionId,
      objectives: input.objectives,
      facts: [...input.facts].reverse(),
      document: input.document,
      brandVersionNumber: input.brandVersionNumber,
      brandVersionId: input.brandVersionId,
      brandId: input.brandId,
    };
    expect(buildBrandSnapshot(reordered).hash).toBe(buildBrandSnapshot(input).hash);
    expect(buildBrandSnapshot(input).facts.map((f) => f.id)).toEqual([
      'fact_01HZZZZZZZZZZZZZZZZZZZZZZA',
      'fact_01HZZZZZZZZZZZZZZZZZZZZZZB',
    ]);
  });

  it('changes when a fact is added or removed (approval or revocation)', () => {
    const h = buildBrandSnapshot(base()).hash;
    const input = base();
    expect(buildBrandSnapshot({ ...input, facts: input.facts.slice(1) }).hash).not.toBe(h);
    expect(
      buildBrandSnapshot({
        ...input,
        facts: [
          ...input.facts,
          {
            id: 'fact_01HZZZZZZZZZZZZZZZZZZZZZZC',
            kind: 'price',
            statement: 'USD 10',
            validFrom: null,
            validUntil: null,
          },
        ],
      }).hash,
    ).not.toBe(h);
  });

  it('changes when an objective, the policy, the document or the version changes', () => {
    const h = buildBrandSnapshot(base()).hash;
    const input = base();
    expect(buildBrandSnapshot({ ...input, objectives: [] }).hash).not.toBe(h);
    expect(
      buildBrandSnapshot({ ...input, policy: { ...input.policy, holdOnDependencyRevocation: false } }).hash,
    ).not.toBe(h);
    expect(buildBrandSnapshot({ ...input, policyVersionId: null }).hash).not.toBe(h);
    expect(
      buildBrandSnapshot({
        ...input,
        document: { ...input.document, voice: { ...input.document.voice, summary: 'Loud' } },
      }).hash,
    ).not.toBe(h);
    expect(buildBrandSnapshot({ ...input, brandVersionId: 'bv_01HZZZZZZZZZZZZZZZZZZZZZZ0' }).hash).not.toBe(
      h,
    );
  });

  it('verifies a stored snapshot and detects tampering', () => {
    const s = buildBrandSnapshot(base());
    expect(verifyBrandSnapshot(s)).toBe(true);
    expect(verifyBrandSnapshot({ ...s, timezone: 'UTC' })).toBe(false);
    expect(verifyBrandSnapshot({ ...s, hash: 'f'.repeat(64) })).toBe(false);
  });
});
