import { describe, expect, it } from 'vitest';
import { RIGHTS_PROCESSING_WINDOW_MS } from '@oremedia/contracts/assets';
import {
  compatibleKinds,
  evaluateEligibility,
  rightsExpiryThreshold,
  type EligibilityCandidate,
} from './eligibility';

const now = new Date('2026-09-24T10:00:00Z');
const hours = (n: number) => new Date(now.getTime() + n * 3600_000);

const approved: EligibilityCandidate = {
  brandId: 'brd_a',
  state: 'approved',
  kind: 'photo',
  rightsState: 'recorded',
  rights: { permittedChannels: 'all', territories: 'all', expiresAt: null },
  grantActive: false,
};
const forBrandA = { brandId: 'brd_a', purpose: 'creative' as const, channelConnectionIds: [] as string[] };

describe('spec 9.2 eligibility rule', () => {
  it('kinds compatible with each purpose, narrowed by an explicit filter', () => {
    expect(compatibleKinds('logo')).toEqual(['logo']);
    expect(compatibleKinds('font')).toEqual(['font']);
    expect(compatibleKinds('creative')).toEqual(['photo', 'illustration', 'icon', 'logo']);
    expect(compatibleKinds('reference').length).toBe(9);
    expect(compatibleKinds('creative', ['photo', 'font'])).toEqual(['photo']);
  });
  it('the expiry threshold is scheduledFor (or now) plus the 24h processing window', () => {
    expect(rightsExpiryThreshold(undefined, now).getTime()).toBe(now.getTime() + RIGHTS_PROCESSING_WINDOW_MS);
    expect(rightsExpiryThreshold(hours(48), now).getTime()).toBe(hours(72).getTime());
  });
  it('only approved assets of the brand (or granted to it) with a compatible kind are eligible', () => {
    expect(evaluateEligibility(approved, forBrandA, now)).toEqual({ eligible: true });
    expect(evaluateEligibility({ ...approved, state: 'pending_review' }, forBrandA, now)).toEqual({
      eligible: false,
      reason: 'state_not_approved',
    });
    expect(evaluateEligibility({ ...approved, state: 'retired' }, forBrandA, now)).toMatchObject({
      eligible: false,
    });
    expect(evaluateEligibility({ ...approved, brandId: 'brd_other' }, forBrandA, now)).toEqual({
      eligible: false,
      reason: 'brand_not_permitted',
    });
    expect(
      evaluateEligibility({ ...approved, brandId: 'brd_other', grantActive: true }, forBrandA, now),
    ).toEqual({
      eligible: true,
    });
    expect(evaluateEligibility({ ...approved, kind: 'font' }, forBrandA, now)).toEqual({
      eligible: false,
      reason: 'kind_incompatible',
    });
    expect(
      evaluateEligibility({ ...approved, kind: 'photo' }, { ...forBrandA, purpose: 'logo' }, now),
    ).toEqual({
      eligible: false,
      reason: 'kind_incompatible',
    });
  });
  it('unknown rights are ineligible for creative and logo purposes, allowed for reference and font', () => {
    const unknown: EligibilityCandidate = { ...approved, rightsState: 'unknown', rights: null };
    expect(evaluateEligibility(unknown, forBrandA, now)).toEqual({
      eligible: false,
      reason: 'rights_unknown',
    });
    expect(evaluateEligibility({ ...unknown, kind: 'logo' }, { ...forBrandA, purpose: 'logo' }, now)).toEqual(
      {
        eligible: false,
        reason: 'rights_unknown',
      },
    );
    expect(evaluateEligibility(unknown, { ...forBrandA, purpose: 'reference' }, now)).toEqual({
      eligible: true,
    });
    expect(evaluateEligibility({ ...unknown, kind: 'font' }, { ...forBrandA, purpose: 'font' }, now)).toEqual(
      {
        eligible: true,
      },
    );
  });
  it('rights must outlive scheduledFor plus the processing window', () => {
    const expiring = (at: Date): EligibilityCandidate => ({
      ...approved,
      rights: { permittedChannels: 'all', territories: 'all', expiresAt: at },
    });
    expect(evaluateEligibility(expiring(hours(23)), forBrandA, now)).toEqual({
      eligible: false,
      reason: 'rights_expired',
    });
    expect(evaluateEligibility(expiring(hours(25)), forBrandA, now)).toEqual({ eligible: true });
    expect(evaluateEligibility(expiring(hours(25)), { ...forBrandA, scheduledFor: hours(2) }, now)).toEqual({
      eligible: false,
      reason: 'rights_expired',
    });
    expect(evaluateEligibility(expiring(hours(27)), { ...forBrandA, scheduledFor: hours(2) }, now)).toEqual({
      eligible: true,
    });
    // Expired rights on a reference asset are still expired.
    expect(evaluateEligibility(expiring(hours(1)), { ...forBrandA, purpose: 'reference' }, now)).toEqual({
      eligible: false,
      reason: 'rights_expired',
    });
  });
  it('rights must permit every requested channel and the requested territory', () => {
    const restricted: EligibilityCandidate = {
      ...approved,
      rights: { permittedChannels: ['cc_1'], territories: ['GB', 'IE'], expiresAt: null },
    };
    expect(evaluateEligibility(restricted, forBrandA, now)).toEqual({ eligible: true });
    expect(evaluateEligibility(restricted, { ...forBrandA, channelConnectionIds: ['cc_1'] }, now)).toEqual({
      eligible: true,
    });
    expect(
      evaluateEligibility(restricted, { ...forBrandA, channelConnectionIds: ['cc_1', 'cc_2'] }, now),
    ).toEqual({
      eligible: false,
      reason: 'channel_not_permitted',
    });
    expect(evaluateEligibility(restricted, { ...forBrandA, territory: 'IE' }, now)).toEqual({
      eligible: true,
    });
    expect(evaluateEligibility(restricted, { ...forBrandA, territory: 'US' }, now)).toEqual({
      eligible: false,
      reason: 'territory_not_permitted',
    });
  });
});
