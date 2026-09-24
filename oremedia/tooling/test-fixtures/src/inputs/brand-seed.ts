import { defaultPolicyDocument, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { approvedFacts, brandObjectives, brandVersions, policyVersions } from '@oremedia/db/schema/brand';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** Brand-owned rows per tenant (on brand 1) so a foreign caller has version, fact, objective and policy ids to try. */
export const BRAND_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const brandVersionId = newId('brandVersion');
  const factId = newId('approvedFact');
  const objectiveId = newId('brandObjective');
  const policyVersionId = newId('policyVersion');
  const document = emptyBrandSystemDocument();
  await db.insert(brandVersions).values({
    id: brandVersionId,
    tenantId,
    brandId,
    number: 1,
    state: 'draft',
    document,
    contentHash: hashCanonical(document),
  });
  await db.insert(approvedFacts).values({
    id: factId,
    tenantId,
    brandId,
    kind: 'claim',
    statement: 'Seeded claim',
    evidence: [{ kind: 'other', ref: 'seed' }],
    state: 'proposed',
    proposedByKind: 'user',
    proposedById: ownerUserId,
  });
  await db.insert(brandObjectives).values({
    id: objectiveId,
    tenantId,
    brandId,
    name: 'Seeded objective',
    primaryMetricKey: 'qualified_enquiries',
    guardrailMetricKeys: [],
    activeFrom: new Date(),
  });
  await db.insert(policyVersions).values({
    id: policyVersionId,
    tenantId,
    brandId,
    number: 1,
    document: defaultPolicyDocument(),
    state: 'draft',
    createdByUserId: ownerUserId,
  });
  return { brandVersionId, factId, objectiveId, policyVersionId };
};
