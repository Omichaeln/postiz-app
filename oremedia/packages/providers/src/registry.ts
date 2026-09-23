import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import type { ProviderAdapter } from './contract';

/**
 * Spec 14.6 / 20.2: a registry keyed by provider key. Only certified adapters (capability.certifiedAt set) can be
 * used for tenants; uncertified adapters are reachable only through `forCertification` (internal tooling).
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.key)) throw new Error(`provider ${adapter.key} already registered`);
    if (adapter.capability.key !== adapter.key) throw new Error(`capability key mismatch for ${adapter.key}`);
    this.adapters.set(adapter.key, adapter);
    return this;
  }

  /** Certified adapters only (tenant-facing). */
  get(key: string): ProviderAdapter {
    const a = this.adapters.get(key);
    if (!a) throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: `unknown_provider:${key}` }]);
    if (!a.capability.certifiedAt)
      throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: `provider_not_certified:${key}` }]);
    return a;
  }

  forCertification(key: string): ProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  capability(key: string): ProviderCapabilityV1 | undefined {
    return this.adapters.get(key)?.capability;
  }

  /** Capabilities visible to the UI and the adaptation skill: certified ones, plus uncertified flagged as such. */
  list(): Array<{ key: string; version: number; certified: boolean; capability: ProviderCapabilityV1 }> {
    return [...this.adapters.values()].map((a) => ({
      key: a.key,
      version: a.capability.version,
      certified: a.capability.certifiedAt !== null,
      capability: a.capability,
    }));
  }
}

export const providerRegistry = new ProviderRegistry();
