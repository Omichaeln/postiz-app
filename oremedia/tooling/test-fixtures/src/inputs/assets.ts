import type { CrossTenantFixture, SeedExtension } from '../cross-tenant-inputs';

/** Filled in by the Phase 2 asset work: one entry per assets.* procedure, every id pointing at the foreign tenant. */
export const ASSETS_INPUTS: Record<string, CrossTenantFixture> = {};

/** Extra rows the harness seeds per tenant so foreign ids exist (assets, versions, intents, templates). */
export const ASSETS_SEED: SeedExtension | null = null;
