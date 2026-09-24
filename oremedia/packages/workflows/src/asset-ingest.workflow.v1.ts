import { proxyActivities } from '@temporalio/workflow';
import type {
  AssetIngestActivitiesV1,
  AssetIngestInputV1,
  AssetIngestResultV1,
  IngestStepRejection,
} from '@oremedia/contracts/assets';

/**
 * Spec 9.1: complete(intentId) → assetIngestWorkflowV1. Deterministic orchestration only: every effect is an
 * activity, every activity re-loads tenant context and the intent (spec 5.2), and a rejected step is a value that
 * ends the run through finaliseUpload with its reason. Once deployed this file is immutable; changes ship as v2.
 */

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state). */
const NON_RETRYABLE_ERROR_TYPES = [
  'PolicyDeniedError',
  'NotFoundError',
  'ValidationFailedError',
  'ConflictError',
  'TenantContextMissingError',
  'IllegalTransitionError',
];

/** Walks the failure chain (ActivityFailure → ApplicationFailure) for a failure type or error name. */
export function isFailureOfType(err: unknown, type: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { type?: string; name?: string; cause?: unknown };
    if (e.type === type || e.name === type) return true;
    current = e.cause;
  }
  return false;
}

/** The orchestration, separated from the activity proxies so it can be exercised with fakes. */
export async function runAssetIngest(
  acts: AssetIngestActivitiesV1,
  input: AssetIngestInputV1,
): Promise<AssetIngestResultV1> {
  const begin = await acts.beginIngest(input);
  const cleanupKeys: string[] = [begin.storageKey];

  const finish = async (
    rejection: IngestStepRejection,
    outcome: 'rejected' | 'quarantined',
  ): Promise<AssetIngestResultV1> => {
    await acts.finaliseUpload({
      ...input,
      outcome,
      reason: rejection.reason,
      ...(rejection.duplicateOfAssetId ? { duplicateOfAssetId: rejection.duplicateOfAssetId } : {}),
      cleanupKeys,
    });
    if (outcome === 'quarantined') return { outcome, reason: rejection.reason };
    return {
      outcome,
      reason: rejection.reason,
      ...(rejection.duplicateOfAssetId ? { duplicateOfAssetId: rejection.duplicateOfAssetId } : {}),
    };
  };

  const verified = await acts.verifyUpload(input); // 1. exists, size ≤ cap
  if (!verified.ok) return finish(verified, 'rejected');

  const sniffed = await acts.sniffUpload(input); // 2. content sniffing is authoritative
  if (!sniffed.ok) return finish(sniffed, 'rejected');

  let scanned; // 3. scan; no verdict (scanner unreachable after retries) → stays quarantined, never accepted
  try {
    scanned = await acts.scanUpload(input);
  } catch (err) {
    if (isFailureOfType(err, 'ScannerUnavailableError'))
      return finish({ ok: false, reason: 'scanner_unavailable' }, 'quarantined');
    throw err;
  }
  if (!scanned.ok)
    return finish(scanned, scanned.reason === 'scanner_unavailable' ? 'quarantined' : 'rejected');

  const sanitised = await acts.sanitiseUpload({ ...input, mime: sniffed.mime, group: sniffed.group }); // 4
  if (!sanitised.ok) return finish(sanitised, 'rejected');
  cleanupKeys.push(sanitised.sanitisedKey);
  if (sanitised.previewKey) cleanupKeys.push(sanitised.previewKey);

  const hashed = await acts.hashUpload({ ...input, sanitisedKey: sanitised.sanitisedKey }); // 5. dedupe proposal
  if (!hashed.ok) return finish(hashed, 'rejected');

  const built = await acts.buildDerivatives({
    ...input,
    sanitisedKey: sanitised.sanitisedKey,
    mime: sanitised.mime,
    group: sniffed.group,
    ...(sanitised.previewKey ? { previewKey: sanitised.previewKey } : {}),
  }); // 6
  if (!built.ok) return finish(built, 'rejected');
  cleanupKeys.push(...built.derivatives.map((d) => d.key));

  const moved = await acts.moveToImmutable({
    ...input,
    sanitisedKey: sanitised.sanitisedKey,
    derivatives: built.derivatives,
  }); // 7

  const catalogued = await acts.catalogueAsset({
    ...input,
    assetId: moved.assetId,
    assetVersionId: moved.assetVersionId,
    originalKey: moved.originalKey,
    contentHash: hashed.contentHash,
    mime: sanitised.mime,
    bytes: sanitised.bytes,
    width: sanitised.width,
    height: sanitised.height,
    colourProfile: sanitised.colourProfile,
    ...(sanitised.fontMetadata ? { fontMetadata: sanitised.fontMetadata } : {}),
    sanitised: sanitised.sanitised,
    derivatives: moved.derivatives,
  }); // 8

  await acts.finaliseUpload({ ...input, outcome: 'accepted', cleanupKeys });
  return {
    outcome: 'accepted',
    assetId: catalogued.assetId,
    assetVersionId: catalogued.assetVersionId,
    state: catalogued.state,
  };
}

export async function assetIngestWorkflowV1(input: AssetIngestInputV1): Promise<AssetIngestResultV1> {
  const fast = proxyActivities<AssetIngestActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Scanning, sanitising and derivative generation read whole objects (up to the caps) and heartbeat.
  const heavy = proxyActivities<AssetIngestActivitiesV1>({
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '2 minutes',
    retry: {
      initialInterval: '10s',
      maximumInterval: '2 minutes',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runAssetIngest(
    {
      beginIngest: fast.beginIngest,
      verifyUpload: fast.verifyUpload,
      sniffUpload: fast.sniffUpload,
      scanUpload: heavy.scanUpload,
      sanitiseUpload: heavy.sanitiseUpload,
      hashUpload: fast.hashUpload,
      buildDerivatives: heavy.buildDerivatives,
      moveToImmutable: fast.moveToImmutable,
      catalogueAsset: fast.catalogueAsset,
      finaliseUpload: fast.finaliseUpload,
    },
    input,
  );
}
