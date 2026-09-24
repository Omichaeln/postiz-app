import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { ProviderRegistry, providerRegistry } from './registry';
import { certifiedForTest } from './testing';

const KEYS = ['linkedin_page', 'instagram_business', 'facebook_page', 'x'];

describe('Release 1 registry (spec 14.6, 14.8): registered, none enabled for tenants until certified', () => {
  it('registers all four adapters with valid capabilities and certifiedAt null', () => {
    const listed = providerRegistry.list();
    expect(listed.map((l) => l.key).sort()).toEqual([...KEYS].sort());
    for (const entry of listed) {
      expect(entry.certified).toBe(false);
      expect(ProviderCapabilityV1.parse(entry.capability).certifiedAt).toBeNull();
      expect(entry.capability.requiredScopes.length).toBeGreaterThan(0);
      expect(entry.capability.rateLimits.length).toBeGreaterThan(0);
    }
  });
  it('get() refuses every uncertified adapter for tenants; forCertification exposes it', () => {
    for (const key of KEYS) {
      expect(() => providerRegistry.get(key)).toThrow(CapabilityUnsupportedError);
      try {
        providerRegistry.get(key);
      } catch (e) {
        expect((e as CapabilityUnsupportedError).details?.[0]?.issue).toBe(`provider_not_certified:${key}`);
      }
      expect(providerRegistry.forCertification(key)?.key).toBe(key);
    }
  });
  it('enabling requires certification: only an explicit certified registration passes the gate', () => {
    const r = new ProviderRegistry();
    for (const key of KEYS) r.register(certifiedForTest(providerRegistry.forCertification(key)!));
    for (const key of KEYS) {
      const a = r.get(key);
      expect(a.key).toBe(key);
      expect(a.capability.certifiedAt).toBe('2026-10-01T00:00:00.000Z');
      expect(typeof a.publish).toBe('function');
    }
    expect(r.list().every((l) => l.certified)).toBe(true);
  });
});
