import type { ProviderAdapter } from '../contract';

/**
 * Test-only: a view of an adapter whose capability carries `certifiedAt`, so a test can prove the registry gate
 * opens only through certification (spec 14.6). Production registration never does this.
 */
export function certifiedForTest(
  adapter: ProviderAdapter,
  certifiedAt = '2026-10-01T00:00:00.000Z',
): ProviderAdapter {
  return Object.create(adapter, {
    capability: { value: { ...adapter.capability, certifiedAt }, enumerable: true },
  }) as ProviderAdapter;
}
