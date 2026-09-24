import { monotonicFactory, ulid } from 'ulid';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';

/**
 * Monotonic within this process: ids minted in the same millisecond still sort in creation order (plain ulid()
 * randomises the tail, so two ids from one call could sort either way). Code that lists by id relies on this,
 * e.g. experiment variants in design order.
 */
const monotonicUlid = monotonicFactory();

/** Spec 6.1: prefixed ULIDs generated in application code. */
export const newId = (kind: IdKind): string => `${ID_PREFIXES[kind]}_${monotonicUlid()}`;

/**
 * Non-monotonic variant for TiDB write-hotspot tables (spec 3.2): random 2-char prefix folded into the
 * time component keeps the 26-char body but breaks monotonic ordering. On MySQL this is unnecessary; the
 * db layer picks per engine (D-01).
 */
export const newShardedId = (kind: IdKind): string => {
  const body = ulid();
  const shard = Math.floor(Math.random() * 32);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `${ID_PREFIXES[kind]}_${alphabet[shard]}${body.slice(1)}`;
};

export const newElementId = (): string => newId('element');
