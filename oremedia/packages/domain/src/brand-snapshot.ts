import { BrandSnapshotV1, type BrandSnapshot } from '@oremedia/contracts/brand';
import { hashCanonical } from './hash';

export type BrandSnapshotBundle = Omit<BrandSnapshot, 'hash'>;

const Bundle = BrandSnapshotV1.omit({ hash: true });

const byId = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Spec 8.3: sha256(canonicalJson(bundle without hash)). Facts, objectives and template ids are sorted so row
 * order never changes the hash: the same input always gives the same hash, and any change to the document, a
 * fact, an objective or the policy changes it.
 */
export function buildBrandSnapshot(input: BrandSnapshotBundle): BrandSnapshot {
  const bundle = Bundle.parse({
    ...input,
    facts: byId(input.facts),
    objectives: byId(input.objectives),
    eligibleTemplateVersionIds: [...input.eligibleTemplateVersionIds].sort(),
  });
  return { ...bundle, hash: hashCanonical(bundle) };
}

/** True when a stored snapshot still hashes to its recorded hash. */
export const verifyBrandSnapshot = (snapshot: BrandSnapshot): boolean =>
  buildBrandSnapshot(snapshot).hash === snapshot.hash;
