import {
  type AssetIngestInputV1,
  type IngestBeginResult,
  type IngestCatalogueInput,
  type IngestCatalogueResult,
  type IngestDerivativeRef,
  type IngestDerivativesInput,
  type IngestDerivativesResult,
  type IngestFinaliseInput,
  type IngestHashInput,
  type IngestHashResult,
  type IngestMoveInput,
  type IngestMoveResult,
  type IngestSanitiseInput,
  type IngestSanitiseResult,
  type IngestScanResult,
  type IngestSniffResult,
  type IngestStepResult,
  type IngestVerifyResult,
  type UploadIntentState,
} from '@oremedia/contracts/assets';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { uploadIntentMachine } from '@oremedia/domain';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { audit, outbox } from '@oremedia/module-operations';
import {
  AssetDerivativeRepository,
  AssetRepository,
  AssetVersionRepository,
  UploadIntentRepository,
  type UploadIntentRow,
} from '../repositories';
import { storageKeys, type StorageProvider } from '../storage';
import type { Scanner } from './scanner';
import * as steps from './steps';

/**
 * The storage-and-database side of each ingest step (spec 9.1), one function per activity. Each call re-loads
 * the intent through the brand-scoped repository (the uploader's grants are re-loaded by the activity's
 * inTenant) and re-verifies that the intent's brand matches the workflow input: nothing carried by the workflow
 * is trusted for an authority decision (spec 5.2).
 */
export interface IngestDeps {
  storage: StorageProvider;
  scanner: Scanner;
  maxPixels?: number;
}

const assetsRepo = new AssetRepository();
const versionsRepo = new AssetVersionRepository();
const derivativesRepo = new AssetDerivativeRepository();
const intentsRepo = new UploadIntentRepository();

async function loadIntent(
  input: AssetIngestInputV1,
  expected: UploadIntentState,
  tx?: Tx,
): Promise<UploadIntentRow> {
  const intent = await intentsRepo.getById(input.intentId, tx);
  if (intent.brandId !== input.brandId) throw new NotFoundError('UploadIntent', input.intentId);
  if (intent.state !== expected)
    throw new ValidationFailedError([{ path: 'intentId', issue: `intent_${intent.state}` }]);
  return intent;
}

const beginResult = (i: UploadIntentRow): IngestBeginResult => ({
  intentId: i.id,
  brandId: i.brandId,
  kind: i.kind,
  declaredMime: i.declaredMime,
  maxBytes: i.maxBytes,
  storageKey: i.storageKey,
});

async function objectOrMissing(
  storage: StorageProvider,
  key: string,
  range?: { start: number; end: number },
): Promise<Buffer | { ok: false; reason: 'object_missing' }> {
  const bytes = await storage.getObject(key, range);
  return bytes ?? { ok: false, reason: 'object_missing' };
}

export const assetIngest = {
  /** uploaded → quarantined. Idempotent: a retry after the transition returns the same projection. */
  async begin(input: AssetIngestInputV1): Promise<IngestBeginResult> {
    return withTransaction(async (tx) => {
      const intent = await intentsRepo.getById(input.intentId, tx);
      if (intent.brandId !== input.brandId) throw new NotFoundError('UploadIntent', input.intentId);
      if (intent.state === 'quarantined') return beginResult(intent);
      if (!uploadIntentMachine.can(intent.state, 'begin_ingest'))
        throw new ValidationFailedError([{ path: 'intentId', issue: `intent_${intent.state}` }]);
      const next = uploadIntentMachine.transition(intent.state, 'begin_ingest');
      await intentsRepo.update(intent.id, intent.version, { state: next }, tx);
      await audit.record(
        input.actor,
        'upload_intent.quarantined',
        { type: 'upload_intent', id: intent.id },
        'allowed',
        tx,
        {
          brandId: intent.brandId,
          fromState: intent.state,
          toState: next,
        },
      );
      return beginResult({ ...intent, state: next });
    });
  },

  async verify(deps: IngestDeps, input: AssetIngestInputV1): Promise<IngestStepResult<IngestVerifyResult>> {
    const intent = await loadIntent(input, 'quarantined');
    return steps.verifyObject(deps.storage, intent.storageKey, intent.maxBytes);
  },

  async sniff(deps: IngestDeps, input: AssetIngestInputV1): Promise<IngestStepResult<IngestSniffResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const head = await objectOrMissing(deps.storage, intent.storageKey, {
      start: 0,
      end: steps.SNIFF_BYTES - 1,
    });
    if (!Buffer.isBuffer(head)) return head;
    return steps.sniffType(head, { kind: intent.kind, mime: intent.declaredMime });
  },

  async scan(deps: IngestDeps, input: AssetIngestInputV1): Promise<IngestStepResult<IngestScanResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const bytes = await objectOrMissing(deps.storage, intent.storageKey);
    if (!Buffer.isBuffer(bytes)) return bytes;
    return steps.scan(deps.scanner, bytes);
  },

  /** Sanitised bytes (and an SVG's PNG preview) are written back under the quarantine prefix, never elsewhere. */
  async sanitise(
    deps: IngestDeps,
    input: IngestSanitiseInput,
  ): Promise<IngestStepResult<IngestSanitiseResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const bytes = await objectOrMissing(deps.storage, intent.storageKey);
    if (!Buffer.isBuffer(bytes)) return bytes;
    const r = await steps.sanitise(bytes, input.mime, input.group, { maxPixels: deps.maxPixels });
    if (!r.ok) return r;
    const { tenantId } = requireTenant();
    const sanitisedKey = storageKeys.quarantine(tenantId, intent.id, 'sanitised');
    await deps.storage.putObject(sanitisedKey, r.bytes, { contentType: r.mime });
    let previewKey: string | undefined;
    if (r.preview) {
      previewKey = storageKeys.quarantine(tenantId, intent.id, 'preview.png');
      await deps.storage.putObject(previewKey, r.preview, { contentType: 'image/png' });
    }
    return {
      ok: true,
      sanitisedKey,
      mime: r.mime,
      bytes: r.bytes.length,
      width: r.width,
      height: r.height,
      colourProfile: r.colourProfile,
      ...(r.fontMetadata ? { fontMetadata: r.fontMetadata } : {}),
      ...(previewKey ? { previewKey } : {}),
      sanitised: r.sanitised,
    };
  },

  async hash(deps: IngestDeps, input: IngestHashInput): Promise<IngestStepResult<IngestHashResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const bytes = await objectOrMissing(deps.storage, input.sanitisedKey);
    if (!Buffer.isBuffer(bytes)) return bytes;
    return steps.hashAndDedupe(
      bytes,
      async (contentHash) => (await versionsRepo.findByHash(intent.brandId, contentHash))?.assetId ?? null,
    );
  },

  async derivatives(
    deps: IngestDeps,
    input: IngestDerivativesInput,
  ): Promise<IngestStepResult<IngestDerivativesResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const bytes = await objectOrMissing(deps.storage, input.sanitisedKey);
    if (!Buffer.isBuffer(bytes)) return bytes;
    let preview: Buffer | undefined;
    if (input.previewKey) {
      const p = await objectOrMissing(deps.storage, input.previewKey);
      if (!Buffer.isBuffer(p)) return p;
      preview = p;
    }
    const r = await steps.derivatives({ bytes, group: input.group, preview }, { maxPixels: deps.maxPixels });
    if (!r.ok) return r;
    const { tenantId } = requireTenant();
    const refs: IngestDerivativeRef[] = [];
    for (const d of r.derivatives) {
      const key = storageKeys.quarantine(tenantId, intent.id, `derivative-${d.purpose}`);
      await deps.storage.putObject(key, d.bytes, { contentType: d.mime });
      refs.push({
        purpose: d.purpose,
        key,
        mime: d.mime,
        width: d.width,
        height: d.height,
        bytes: d.bytes.length,
        contentHash: sha256Hex(d.bytes),
        transform: d.transform,
      });
    }
    return { ok: true, derivatives: refs };
  },

  /** Copies the sanitised objects to their immutable keys and deletes the quarantine upload (step 7). */
  async move(deps: IngestDeps, input: IngestMoveInput): Promise<IngestMoveResult> {
    const intent = await loadIntent(input, 'quarantined');
    const { tenantId } = requireTenant();
    const assetId = newId('asset');
    const assetVersionId = newId('assetVersion');
    const originalKey = storageKeys.original(tenantId, intent.brandId, assetId, assetVersionId);
    const derivatives = input.derivatives.map((d) => ({
      ...d,
      key: storageKeys.derivative(tenantId, intent.brandId, assetId, assetVersionId, d.purpose),
    }));
    await steps.moveToImmutable(deps.storage, {
      copies: [
        { fromKey: input.sanitisedKey, toKey: originalKey },
        ...input.derivatives.map((d, i) => ({ fromKey: d.key, toKey: derivatives[i]?.key as string })),
      ],
      deleteKeys: [intent.storageKey],
    });
    return { assetId, assetVersionId, originalKey, derivatives };
  },

  /**
   * Step 8: asset, version and derivative rows, the intent's acceptance and the outbox event commit together.
   * `autoApprove` is decided by the caller from policy (asset.approve held by the uploader) and passed in.
   */
  async catalogue(input: IngestCatalogueInput & { autoApprove: boolean }): Promise<IngestCatalogueResult> {
    return withTransaction(async (tx) => {
      const intent = await intentsRepo.getById(input.intentId, tx);
      if (intent.brandId !== input.brandId) throw new NotFoundError('UploadIntent', input.intentId);
      if (intent.state === 'accepted' && intent.resultAssetId) {
        const existing = await assetsRepo.getById(intent.resultAssetId, tx);
        return {
          assetId: existing.id,
          assetVersionId: existing.currentVersionId ?? input.assetVersionId,
          state: existing.state,
        };
      }
      if (intent.state !== 'quarantined')
        throw new ValidationFailedError([{ path: 'intentId', issue: `intent_${intent.state}` }]);
      const state = steps.initialAssetState(input.autoApprove);
      await assetsRepo.create(
        {
          id: input.assetId,
          brandId: intent.brandId,
          kind: intent.kind,
          name: intent.originalFilename.slice(0, 200),
          currentVersionId: input.assetVersionId,
          state,
          rightsState: 'unknown',
        },
        tx,
      );
      await versionsRepo.create(
        {
          id: input.assetVersionId,
          brandId: intent.brandId,
          assetId: input.assetId,
          number: 1,
          storageKey: input.originalKey,
          contentHash: input.contentHash,
          mime: input.mime,
          bytes: input.bytes,
          width: input.width,
          height: input.height,
          colourProfile: input.colourProfile,
          provenance: {
            kind: 'upload',
            uploadedByUserId: intent.createdByUserId,
            originalFilename: intent.originalFilename,
            ...(input.fontMetadata ? { fontMetadata: input.fontMetadata } : {}),
            sanitised: input.sanitised,
          },
        },
        tx,
      );
      for (const d of input.derivatives)
        await derivativesRepo.create(
          {
            id: newId('assetDerivative'),
            brandId: intent.brandId,
            assetVersionId: input.assetVersionId,
            purpose: d.purpose,
            transform: d.transform,
            storageKey: d.key,
            contentHash: d.contentHash,
            mime: d.mime,
            width: d.width,
            height: d.height,
            bytes: d.bytes,
          },
          tx,
        );
      const next = uploadIntentMachine.transition(intent.state, 'accept');
      await intentsRepo.update(intent.id, intent.version, { state: next, resultAssetId: input.assetId }, tx);
      await audit.record(input.actor, 'asset.ingested', { type: 'asset', id: input.assetId }, 'allowed', tx, {
        brandId: intent.brandId,
        toState: state,
      });
      await outbox.add(
        'asset.ingested',
        { type: 'asset', id: input.assetId, version: 0 },
        {
          assetId: input.assetId,
          assetVersionId: input.assetVersionId,
          uploadIntentId: intent.id,
          brandId: intent.brandId,
          state,
        },
        tx,
        { brandId: intent.brandId },
      );
      return { assetId: input.assetId, assetVersionId: input.assetVersionId, state };
    });
  },

  /**
   * Records the terminal outcome on the intent (rejected with the reason, or held in quarantine when the scanner
   * gave no verdict) and deletes the intent's quarantine objects. Only keys under this intent's quarantine prefix
   * are deleted; anything else is refused.
   */
  async finalise(deps: IngestDeps, input: IngestFinaliseInput): Promise<void> {
    await withTransaction(async (tx) => {
      const intent = await intentsRepo.getById(input.intentId, tx);
      if (intent.brandId !== input.brandId) throw new NotFoundError('UploadIntent', input.intentId);
      if (input.outcome === 'rejected' && uploadIntentMachine.can(intent.state, 'reject')) {
        const next = uploadIntentMachine.transition(intent.state, 'reject');
        await intentsRepo.update(
          intent.id,
          intent.version,
          {
            state: next,
            rejectionReason: input.reason ?? null,
            resultAssetId: input.duplicateOfAssetId ?? null,
          },
          tx,
        );
        await audit.record(
          input.actor,
          'upload_intent.rejected',
          { type: 'upload_intent', id: intent.id },
          'allowed',
          tx,
          {
            brandId: intent.brandId,
            fromState: intent.state,
            toState: next,
            reason: input.reason ?? null,
          },
        );
      } else if (input.outcome === 'quarantined' && intent.state === 'quarantined') {
        await intentsRepo.update(intent.id, intent.version, { rejectionReason: input.reason ?? null }, tx);
        await audit.record(
          input.actor,
          'upload_intent.held',
          { type: 'upload_intent', id: intent.id },
          'allowed',
          tx,
          {
            brandId: intent.brandId,
            reason: input.reason ?? null,
          },
        );
      }
    });
    const { tenantId } = requireTenant();
    const prefix = storageKeys.quarantine(tenantId, input.intentId);
    for (const key of input.cleanupKeys) {
      if (key !== prefix && !key.startsWith(`${prefix}/`))
        throw new PolicyDeniedError(
          'cleanup_key_outside_quarantine',
          'Only this intent’s quarantine objects can be deleted',
        );
      await deps.storage.deleteObject(key);
    }
  },
};
