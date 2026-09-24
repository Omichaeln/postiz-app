import type { AssetIngestActivitiesV1 } from '@oremedia/contracts/assets';
import { policy } from '@oremedia/module-access';
import {
  ScannerUnavailableError,
  assetIngest,
  createScannerFromEnv,
  storage,
  type IngestDeps,
} from '@oremedia/module-assets';
import { loadActorGrants, resolveActivityActor } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Spec 9.1 activities for assetIngestWorkflowV1: thin wrappers that establish tenant context (re-loading the
 * uploader's grants) and call the module. Storage and scanner come from the environment unless a worker passes
 * its own (tests pass MemoryStorageProvider and FakeScanner).
 */
export function createAssetIngestActivities(overrides: Partial<IngestDeps> = {}): AssetIngestActivitiesV1 {
  let cached: IngestDeps | null = null;
  const deps = (): IngestDeps => {
    if (!cached)
      cached = {
        storage: overrides.storage ?? storage(),
        scanner: overrides.scanner ?? createScannerFromEnv(),
        ...(overrides.maxPixels !== undefined ? { maxPixels: overrides.maxPixels } : {}),
      };
    return cached;
  };
  return {
    beginIngest: (input) => inTenant(input, loadActorGrants, () => assetIngest.begin(input)),
    verifyUpload: (input) => inTenant(input, loadActorGrants, () => assetIngest.verify(deps(), input)),
    sniffUpload: (input) => inTenant(input, loadActorGrants, () => assetIngest.sniff(deps(), input)),
    scanUpload: (input) =>
      inTenant(input, loadActorGrants, async () => {
        heartbeat('scan');
        const r = await assetIngest.scan(deps(), input);
        // No verdict is an infrastructure failure: thrown so Temporal retries; the workflow holds the intent in quarantine.
        if (!r.ok && r.retryable) throw new ScannerUnavailableError(r.detail ?? r.reason);
        return r;
      }),
    sanitiseUpload: (input) =>
      inTenant(input, loadActorGrants, () => {
        heartbeat('sanitise');
        return assetIngest.sanitise(deps(), input);
      }),
    hashUpload: (input) => inTenant(input, loadActorGrants, () => assetIngest.hash(deps(), input)),
    buildDerivatives: (input) =>
      inTenant(input, loadActorGrants, () => {
        heartbeat('derivatives');
        return assetIngest.derivatives(deps(), input);
      }),
    moveToImmutable: (input) => inTenant(input, loadActorGrants, () => assetIngest.move(deps(), input)),
    catalogueAsset: (input) =>
      inTenant(input, loadActorGrants, async () => {
        // Spec 9.1 step 8: approved only if the uploader holds asset.approve *now*; decided here and passed explicitly.
        const { actor } = await resolveActivityActor(input);
        const decision = await policy.decide(actor, 'asset.approve', {
          type: 'brand',
          tenantId: input.tenantId,
          brandId: input.brandId,
          id: input.brandId,
        });
        return assetIngest.catalogue({ ...input, autoApprove: decision.allowed });
      }),
    finaliseUpload: (input) => inTenant(input, loadActorGrants, () => assetIngest.finalise(deps(), input)),
  };
}
