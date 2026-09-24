import { sha256Hex } from '../hash';

export interface AssignmentArm {
  /** The variant id (or label) the unit is assigned to. */
  id: string;
  allocationWeight: number;
}

/**
 * Spec 16.6 randomised link experiments: a visitor hash (already salted per tenant by the redirector) is mapped to
 * an arm by hashing it with the experiment id and walking the cumulative allocation weights. Pure and
 * deterministic, so the redirector and the experiments module always agree on the same assignment without a
 * lookup. Arms are taken in the order given; the caller sorts them by id for a stable mapping.
 */
export function assignVariant(
  visitorHash: string,
  experimentId: string,
  arms: readonly AssignmentArm[],
): string {
  if (arms.length === 0) throw new Error('assignVariant: no arms');
  const total = arms.reduce((s, a) => s + a.allocationWeight, 0);
  if (!(total > 0)) throw new Error('assignVariant: allocation weights must sum to a positive number');
  // 52 bits of the digest as a uniform number in [0, 1).
  const digest = sha256Hex(`${experimentId}:${visitorHash}`);
  const point = (parseInt(digest.slice(0, 13), 16) / 2 ** 52) * total;
  let cumulative = 0;
  for (const arm of arms) {
    cumulative += arm.allocationWeight;
    if (point < cumulative) return arm.id;
  }
  return (arms[arms.length - 1] as AssignmentArm).id;
}
