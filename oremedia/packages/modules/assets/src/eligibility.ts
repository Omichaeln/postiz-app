import type { AssetKind, AssetPurpose, AssetState, EligibilityReason } from '@oremedia/contracts/assets';
import {
  PURPOSES_REQUIRING_RIGHTS,
  PURPOSE_KINDS,
  RIGHTS_PROCESSING_WINDOW_MS,
} from '@oremedia/contracts/assets';

/**
 * Spec 9.2, as a pure decision so search and authoriseUse cannot drift apart. The repository applies the
 * SQL-expressible part of the filter (tenant, brand or grant, state, kind, rights presence and expiry); this
 * function is the single place that states the whole rule and is re-applied to every candidate.
 */
export interface RightsRecord {
  permittedChannels: 'all' | string[];
  territories: 'all' | string[];
  expiresAt: Date | null;
}

export interface EligibilityCandidate {
  brandId: string;
  state: AssetState;
  kind: AssetKind;
  rightsState: 'unknown' | 'recorded';
  rights: RightsRecord | null;
  /** An unexpired asset_grant to the requesting brand for the requested purpose exists. */
  grantActive: boolean;
}

export interface EligibilityRequest {
  brandId: string;
  purpose: AssetPurpose;
  channelConnectionIds: readonly string[];
  territory?: string;
  scheduledFor?: Date;
  kinds?: readonly AssetKind[];
}

export type EligibilityVerdict = { eligible: true } | { eligible: false; reason: EligibilityReason };

const ineligible = (reason: EligibilityReason): EligibilityVerdict => ({ eligible: false, reason });

/** Kinds compatible with the purpose, narrowed by an explicit kinds filter when given. */
export function compatibleKinds(purpose: AssetPurpose, requested?: readonly AssetKind[]): AssetKind[] {
  const base = PURPOSE_KINDS[purpose];
  return requested ? base.filter((k) => requested.includes(k)) : [...base];
}

export const rightsRequired = (purpose: AssetPurpose): boolean => PURPOSES_REQUIRING_RIGHTS.includes(purpose);

/** Rights must outlive the scheduled time (or now) plus the processing window (spec 9.2). */
export function rightsExpiryThreshold(scheduledFor: Date | undefined, now: Date): Date {
  return new Date((scheduledFor ?? now).getTime() + RIGHTS_PROCESSING_WINDOW_MS);
}

export function evaluateEligibility(
  c: EligibilityCandidate,
  q: EligibilityRequest,
  now: Date,
): EligibilityVerdict {
  if (c.state !== 'approved') return ineligible('state_not_approved');
  if (c.brandId !== q.brandId && !c.grantActive) return ineligible('brand_not_permitted');
  if (!compatibleKinds(q.purpose, q.kinds).includes(c.kind)) return ineligible('kind_incompatible');
  const needsRights = rightsRequired(q.purpose);
  if (needsRights && (c.rightsState !== 'recorded' || !c.rights)) return ineligible('rights_unknown');
  if (c.rights) {
    if (
      c.rights.expiresAt &&
      c.rights.expiresAt.getTime() <= rightsExpiryThreshold(q.scheduledFor, now).getTime()
    )
      return ineligible('rights_expired');
    if (c.rights.permittedChannels !== 'all') {
      const permitted = new Set(c.rights.permittedChannels);
      if (q.channelConnectionIds.some((id) => !permitted.has(id))) return ineligible('channel_not_permitted');
    }
    if (q.territory && c.rights.territories !== 'all' && !c.rights.territories.includes(q.territory))
      return ineligible('territory_not_permitted');
  }
  return { eligible: true };
}
