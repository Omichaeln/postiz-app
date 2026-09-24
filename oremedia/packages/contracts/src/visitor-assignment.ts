import { createHash, createHmac } from 'node:crypto';

/**
 * Spec 15.4 / 16.5 / 16.6: the keyed hashes and the arm assignment the redirector (apps/redirector, which may import
 * only contracts, db and observability) and the modules (through @oremedia/domain, which re-exports these) must
 * compute identically. Pure and dependency-free apart from node:crypto; never exported from the package index, so
 * browser bundles never see it.
 */

/**
 * Per-tenant keyed hash: salt = HMAC(secret, `tenant:<tenantId>`), hash = HMAC(salt, material). The same material in
 * two tenants never hashes alike, and rotating the secret changes every hash.
 */
export function tenantKeyedHash(secret: string, tenantId: string, material: string): string {
  const salt = createHmac('sha256', secret).update(`tenant:${tenantId}`).digest();
  return createHmac('sha256', salt).update(material).digest('hex');
}

/**
 * The redirector's visitor id: the tenant-keyed hash of the visitor material (IP and user agent) and the UTC day, so
 * a visitor is stable within a day and tenant, and neither identifiable afterwards nor linkable across tenants.
 */
export function visitorHash(
  secret: string,
  tenantId: string,
  visitorMaterial: string,
  at = new Date(),
): string {
  return tenantKeyedHash(secret, tenantId, `${visitorMaterial}|${at.toISOString().slice(0, 10)}`);
}

export interface AssignmentArm {
  /** The variant id (or label) the unit is assigned to. */
  id: string;
  allocationWeight: number;
}

/**
 * Spec 16.6 randomised link experiments: a visitor hash (salted per tenant by visitorHash) is mapped to an arm by
 * hashing it with the experiment id and walking the cumulative allocation weights. Pure and deterministic, so the
 * redirector and the experiments module always agree on the same assignment without a lookup. Arms are taken in
 * the order given; callers sort them by id for a stable mapping.
 */
export function assignVariant(
  visitorHashValue: string,
  experimentId: string,
  arms: readonly AssignmentArm[],
): string {
  if (arms.length === 0) throw new Error('assignVariant: no arms');
  const total = arms.reduce((s, a) => s + a.allocationWeight, 0);
  if (!(total > 0)) throw new Error('assignVariant: allocation weights must sum to a positive number');
  // 52 bits of the digest as a uniform number in [0, 1).
  const digest = createHash('sha256').update(`${experimentId}:${visitorHashValue}`).digest('hex');
  const point = (parseInt(digest.slice(0, 13), 16) / 2 ** 52) * total;
  let cumulative = 0;
  for (const arm of arms) {
    cumulative += arm.allocationWeight;
    if (point < cumulative) return arm.id;
  }
  return (arms[arms.length - 1] as AssignmentArm).id;
}
