import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  ACCEPTED_MIMES,
  ARCHIVE_MIMES,
  AssetApprove,
  AssetGet,
  AssetGrantCreate,
  AssetRetire,
  AssetSearch,
  AssetUsagesList,
  AssetVersionsList,
  EligibilityQuery,
  KIND_MIME_GROUPS,
  KINDS_NOT_PROCESSABLE,
  MediaSignedUrlRequest,
  SIGNED_URL_TTL_SEC,
  UPLOAD_CAPS_BYTES,
  UPLOAD_INTENT_TTL_SEC,
  UploadIntentComplete,
  UploadIntentCreate,
  UsageRightsInput,
  type AssetPurpose,
  type AssetRef,
  type DerivativePurpose,
} from '@oremedia/contracts/assets';
import {
  NotFoundError,
  PolicyDeniedError,
  ReleaseIntegrityError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { assetMachine, uploadIntentMachine } from '@oremedia/domain';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { audit, outbox } from '@oremedia/module-operations';
import { compatibleKinds, evaluateEligibility, rightsExpiryThreshold, rightsRequired } from './eligibility';
import {
  AssetDerivativeRepository,
  AssetGrantRepository,
  AssetRepository,
  AssetUsageRepository,
  AssetVersionRepository,
  UploadIntentRepository,
  UsageRightsRepository,
  type AssetRow,
  type AssetVersionRow,
} from './repositories';
import { storage, storageKeys } from './storage';

const assetsRepo = new AssetRepository();
const versionsRepo = new AssetVersionRepository();
const derivativesRepo = new AssetDerivativeRepository();
const rightsRepo = new UsageRightsRepository();
const grantsRepo = new AssetGrantRepository();
const usagesRepo = new AssetUsageRepository();
const intentsRepo = new UploadIntentRepository();

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const brandResource = (brandId: string) => ({
  type: 'brand',
  tenantId: requireTenant().tenantId,
  brandId,
  id: brandId,
});

const assetResource = (a: AssetRow) => ({
  type: 'asset',
  tenantId: requireTenant().tenantId,
  brandId: a.brandId,
  id: a.id,
  state: a.state,
});

const toRef = (a: AssetRow, v: AssetVersionRow): AssetRef => ({
  assetId: a.id,
  assetVersionId: v.id,
  kind: a.kind,
  semanticRole: a.semanticRole,
  altText: v.altText,
  contentHash: v.contentHash,
  width: v.width,
  height: v.height,
});

const versionView = (v: AssetVersionRow) => ({
  id: v.id,
  assetId: v.assetId,
  number: v.number,
  mime: v.mime,
  bytes: v.bytes,
  width: v.width,
  height: v.height,
  durationMs: v.durationMs,
  colourProfile: v.colourProfile,
  focalPoint: v.focalPoint,
  altText: v.altText,
  contentHash: v.contentHash,
  provenance: v.provenance,
  createdAt: v.createdAt,
});

export interface AuthoriseUseOptions {
  /** The brand the asset is being used for (its own brand, or a grantee brand). */
  brandId: string;
  channelConnectionIds?: readonly string[];
  territory?: string;
  scheduledFor?: Date;
  now?: Date;
}

export const assetService = {
  /** Spec 9.1: declared mime and size are checked against the kind's accepted list and cap; returns a presigned PUT. */
  async createIntent(actor: ResolvedActor, input: z.infer<typeof UploadIntentCreate>, tx: Tx) {
    const parsed = UploadIntentCreate.parse(input);
    const { tenantId } = requireTenant();
    await brandService.assertExist([parsed.brandId], tx);
    assetsRepo.assertBrandVisible(parsed.brandId); // an invisible brand behaves like a missing one (spec 5.3)
    const decision = await policy.assert(actor, 'asset.upload', brandResource(parsed.brandId), {}, tx);
    if (decision.obligations?.some((o) => o.type === 'propose_only'))
      throw new PolicyDeniedError('propose_only', 'Agents may only propose uploads');
    const mime = parsed.declaredMime.toLowerCase();
    if (ARCHIVE_MIMES.includes(mime))
      throw new ValidationFailedError([{ path: 'declaredMime', issue: 'archives_rejected' }]);
    if (KINDS_NOT_PROCESSABLE.includes(parsed.kind))
      throw new ValidationFailedError([{ path: 'kind', issue: 'processing_not_available_in_release_1' }]);
    const group = KIND_MIME_GROUPS[parsed.kind].find((g) => ACCEPTED_MIMES[g]?.includes(mime));
    if (!group)
      throw new ValidationFailedError([{ path: 'declaredMime', issue: 'mime_not_accepted_for_kind' }]);
    const maxBytes = UPLOAD_CAPS_BYTES[group] as number;
    if (parsed.declaredBytes > maxBytes)
      throw new ValidationFailedError([{ path: 'declaredBytes', issue: `exceeds_cap_${maxBytes}` }]);
    const id = newId('uploadIntent');
    const storageKey = storageKeys.quarantine(tenantId, id);
    const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_SEC * 1000);
    await intentsRepo.create(
      {
        id,
        brandId: parsed.brandId,
        kind: parsed.kind,
        declaredMime: mime,
        declaredBytes: parsed.declaredBytes,
        maxBytes,
        storageKey,
        originalFilename: parsed.originalFilename,
        state: 'issued',
        createdByUserId: actor.id,
        expiresAt,
      },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'upload_intent.created',
      { type: 'upload_intent', id },
      'allowed',
      tx,
      {
        brandId: parsed.brandId,
      },
    );
    const upload = await storage().signUploadUrl(storageKey, {
      contentType: mime,
      expiresInSec: UPLOAD_INTENT_TTL_SEC,
    });
    return { intentId: id, uploadUrl: upload.url, expiresAt, maxBytes };
  },

  /** issued → uploaded; the outbox event's consumer is assetIngestWorkflowV1 (spec 9.1 "complete → Temporal"). */
  async completeUpload(actor: ResolvedActor, input: z.infer<typeof UploadIntentComplete>, tx: Tx) {
    const parsed = UploadIntentComplete.parse(input);
    const intent = await intentsRepo.getById(parsed.intentId, tx);
    await policy.assert(actor, 'asset.upload', brandResource(intent.brandId), {}, tx);
    if (intent.expiresAt.getTime() < Date.now())
      throw new ValidationFailedError([{ path: 'intentId', issue: 'intent_expired' }]);
    if (!uploadIntentMachine.can(intent.state, 'complete'))
      throw new ValidationFailedError([{ path: 'intentId', issue: `intent_${intent.state}` }]);
    const next = uploadIntentMachine.transition(intent.state, 'complete');
    await intentsRepo.update(intent.id, intent.version, { state: next }, tx);
    await audit.record(
      actorRef(actor),
      'upload_intent.completed',
      { type: 'upload_intent', id: intent.id },
      'allowed',
      tx,
      { brandId: intent.brandId, fromState: intent.state, toState: next },
    );
    await outbox.add(
      'asset.upload_completed',
      { type: 'upload_intent', id: intent.id, version: intent.version + 1 },
      { uploadIntentId: intent.id, brandId: intent.brandId, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: intent.brandId },
    );
    return { intentId: intent.id, state: next };
  },

  /** Any asset id from a client is loaded through the scoped repository first; a foreign id is NOT_FOUND. */
  async get(actor: ResolvedActor, input: z.infer<typeof AssetGet>, tx?: Tx) {
    const { assetId } = AssetGet.parse(input);
    const a = await assetsRepo.getById(assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    const current = a.currentVersionId ? await versionsRepo.findById(a.currentVersionId, tx) : null;
    const rights = await rightsRepo.findForAsset(a.id, tx);
    const derivatives = current ? await derivativesRepo.listForVersion(current.id, tx) : [];
    return {
      id: a.id,
      brandId: a.brandId,
      kind: a.kind,
      name: a.name,
      semanticRole: a.semanticRole,
      state: a.state,
      rightsState: a.rightsState,
      version: a.version,
      currentVersion: current ? versionView(current) : null,
      derivatives: derivatives.map((d) => ({
        id: d.id,
        purpose: d.purpose,
        mime: d.mime,
        width: d.width,
        height: d.height,
        bytes: d.bytes,
      })),
      rights: rights
        ? {
            id: rights.id,
            owner: rights.owner,
            licenceRef: rights.licenceRef,
            permittedChannels: rights.permittedChannels,
            territories: rights.territories,
            expiresAt: rights.expiresAt,
            releases: rights.releases,
            restrictions: rights.restrictions,
            version: rights.version,
          }
        : null,
    };
  },

  async listVersions(actor: ResolvedActor, input: z.infer<typeof AssetVersionsList>, tx?: Tx) {
    const parsed = AssetVersionsList.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    const p = await versionsRepo.listForAsset(a.id, parsed.page, tx);
    return { items: p.items.map(versionView), nextCursor: p.nextCursor };
  },

  /** Spec 7.5 `search`: the eligibility filter (9.2) runs before anything else; ineligible assets never appear. */
  async search(actor: ResolvedActor, input: z.infer<typeof AssetSearch>, tx?: Tx): Promise<Page<AssetRef>> {
    const parsed = AssetSearch.parse(input);
    await brandService.assertExist([parsed.query.brandId], tx);
    assetsRepo.assertBrandVisible(parsed.query.brandId);
    await policy.assert(actor, 'asset.read', brandResource(parsed.query.brandId), {}, tx);
    return assetService.findEligibleAssets(parsed.query, parsed.page, tx);
  },

  /**
   * Spec 9.2 `findEligibleAssets(query, purpose)`: tenant ∧ (brand ∨ active grant for purpose) ∧ approved ∧ rights
   * permitting channels, territory and the date range ∧ kind compatible with purpose. Applied BEFORE any ranking
   * or retrieval; the same rule (evaluateEligibility) is re-run per row and again by authoriseUse.
   */
  async findEligibleAssets(
    query: EligibilityQuery,
    req: PageRequest,
    tx?: Tx,
    now: Date = new Date(),
  ): Promise<Page<AssetRef>> {
    const q = EligibilityQuery.parse(query);
    const scheduledFor = q.scheduledFor ? new Date(q.scheduledFor) : undefined;
    const kinds = compatibleKinds(q.purpose, q.kinds);
    const candidates = await assetsRepo.findEligibleCandidates(
      {
        brandId: q.brandId,
        purpose: q.purpose,
        kinds,
        rightsRequired: rightsRequired(q.purpose),
        expiryThreshold: rightsExpiryThreshold(scheduledFor, now),
        now,
        text: q.query,
      },
      req,
      tx,
    );
    const request = {
      brandId: q.brandId,
      purpose: q.purpose,
      channelConnectionIds: q.channelConnectionIds,
      territory: q.territory,
      scheduledFor,
      kinds: q.kinds,
    };
    const items: AssetRef[] = [];
    for (const c of candidates.items) {
      if (!c.version) continue;
      const verdict = evaluateEligibility(
        {
          brandId: c.asset.brandId,
          state: c.asset.state,
          kind: c.asset.kind,
          rightsState: c.asset.rightsState,
          rights: c.rights,
          grantActive: c.grantId !== null,
        },
        request,
        now,
      );
      if (verdict.eligible) items.push(toRef(c.asset, c.version));
    }
    return { items, nextCursor: candidates.nextCursor };
  },

  /**
   * Spec 9.2: re-runs the eligibility rule for one version at the point of effect (render, dispatch). Throws
   * RIGHTS_INELIGIBLE with the reason; rights expiring between approval and publication cause a hold, never a
   * silent publish.
   */
  async authoriseUse(assetVersionId: string, purpose: AssetPurpose, opts: AuthoriseUseOptions, tx?: Tx) {
    assetsRepo.assertBrandVisible(opts.brandId);
    const version = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    const asset = await assetsRepo.findInTenant(version.assetId, tx);
    if (!asset) throw new NotFoundError('Asset', version.assetId);
    if (asset.currentVersionId !== version.id)
      throw new RightsIneligibleError(version.id, 'version_not_current');
    const now = opts.now ?? new Date();
    const grant =
      asset.brandId === opts.brandId
        ? null
        : await grantsRepo.findActive(asset.id, opts.brandId, purpose, now, tx);
    const rights = await rightsRepo.findForAsset(asset.id, tx);
    const verdict = evaluateEligibility(
      {
        brandId: asset.brandId,
        state: asset.state,
        kind: asset.kind,
        rightsState: asset.rightsState,
        rights,
        grantActive: grant !== null,
      },
      {
        brandId: opts.brandId,
        purpose,
        channelConnectionIds: opts.channelConnectionIds ?? [],
        territory: opts.territory,
        scheduledFor: opts.scheduledFor,
      },
      now,
    );
    if (!verdict.eligible) throw new RightsIneligibleError(version.id, verdict.reason);
    return {
      assetId: asset.id,
      assetVersionId: version.id,
      brandId: asset.brandId,
      contentHash: version.contentHash,
    };
  },

  /** Upsert of the single usage_rights row per asset; marks the asset's rights as recorded. */
  async setRights(actor: ResolvedActor, input: z.infer<typeof UsageRightsInput>, tx: Tx) {
    const parsed = UsageRightsInput.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.manage_rights', assetResource(a), {}, tx);
    const values = {
      owner: parsed.owner,
      licenceRef: parsed.licenceRef ?? null,
      permittedChannels: parsed.permittedChannels,
      territories: parsed.territories,
      expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      releases: parsed.releases,
      restrictions: parsed.restrictions,
    };
    const existing = await rightsRepo.findForAsset(a.id, tx);
    let id: string;
    if (existing) {
      id = existing.id;
      await rightsRepo.update(existing.id, existing.version, values, tx);
    } else {
      id = newId('usageRights');
      await rightsRepo.create({ id, brandId: a.brandId, assetId: a.id, ...values }, tx);
    }
    if (a.rightsState !== 'recorded')
      await assetsRepo.update(a.id, a.version, { rightsState: 'recorded' }, tx);
    await audit.record(
      actorRef(actor),
      'asset.rights_recorded',
      { type: 'usage_rights', id },
      'allowed',
      tx,
      {
        brandId: a.brandId,
      },
    );
    return { usageRightsId: id };
  },

  async approve(actor: ResolvedActor, input: z.infer<typeof AssetApprove>, tx: Tx) {
    const parsed = AssetApprove.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.approve', assetResource(a), {}, tx);
    if (!assetMachine.can(a.state, 'approve'))
      throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
    const next = assetMachine.transition(a.state, 'approve');
    await assetsRepo.update(a.id, parsed.expectedVersion, { state: next }, tx);
    await audit.record(actorRef(actor), 'asset.approved', { type: 'asset', id: a.id }, 'allowed', tx, {
      brandId: a.brandId,
      fromState: a.state,
      toState: next,
    });
    return { assetId: a.id, state: next, version: parsed.expectedVersion + 1 };
  },

  async retire(actor: ResolvedActor, input: z.infer<typeof AssetRetire>, tx: Tx) {
    const parsed = AssetRetire.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.approve', assetResource(a), {}, tx);
    if (!assetMachine.can(a.state, 'retire'))
      throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
    const next = assetMachine.transition(a.state, 'retire');
    await assetsRepo.update(a.id, parsed.expectedVersion, { state: next }, tx);
    await audit.record(actorRef(actor), 'asset.retired', { type: 'asset', id: a.id }, 'allowed', tx, {
      brandId: a.brandId,
      fromState: a.state,
      toState: next,
      reason: parsed.reason ?? null,
    });
    await outbox.add(
      'asset.retired',
      { type: 'asset', id: a.id, version: parsed.expectedVersion + 1 },
      { assetId: a.id, brandId: a.brandId, reason: parsed.reason ?? null },
      tx,
      { brandId: a.brandId },
    );
    return { assetId: a.id, state: next, version: parsed.expectedVersion + 1 };
  },

  async listUsages(actor: ResolvedActor, input: z.infer<typeof AssetUsagesList>, tx?: Tx) {
    const parsed = AssetUsagesList.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    const versionIds = await versionsRepo.idsForAsset(a.id, tx);
    const p = await usagesRepo.listForVersions(versionIds, parsed.page, tx);
    return {
      items: p.items.map((u) => ({
        id: u.id,
        assetVersionId: u.assetVersionId,
        usedByType: u.usedByType,
        usedById: u.usedById,
        createdAt: u.createdAt,
      })),
      nextCursor: p.nextCursor,
    };
  },

  /** Records that a version is used by a revision, export or publication (impact analysis). Idempotent. */
  async recordUsage(assetVersionId: string, usedByType: string, usedById: string, tx: Tx) {
    const version = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!version) throw new NotFoundError('AssetVersion', assetVersionId);
    try {
      await usagesRepo.record(
        {
          id: newId('assetUsage'),
          brandId: version.brandId,
          assetVersionId: version.id,
          usedByType,
          usedById,
        },
        tx,
      );
    } catch (err) {
      const code =
        (err as { code?: string } | undefined)?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== 'ER_DUP_ENTRY') throw err;
    }
  },

  /** Spec 5.1 cross-brand reuse inside one tenant: both brands must exist here; a foreign brand is NOT_FOUND. */
  async createGrant(actor: ResolvedActor, input: z.infer<typeof AssetGrantCreate>, tx: Tx) {
    const parsed = AssetGrantCreate.parse(input);
    const a = await assetsRepo.getById(parsed.assetId, tx);
    await policy.assert(actor, 'asset.manage_rights', assetResource(a), {}, tx);
    await brandService.assertExist([parsed.granteeBrandId], tx);
    if (parsed.granteeBrandId === a.brandId)
      throw new ValidationFailedError([{ path: 'granteeBrandId', issue: 'grantee_is_owner_brand' }]);
    if (a.state === 'retired' || a.state === 'rejected')
      throw new ValidationFailedError([{ path: 'assetId', issue: `asset_${a.state}` }]);
    if (await grantsRepo.find(a.id, parsed.granteeBrandId, parsed.purpose, tx))
      throw new ValidationFailedError([{ path: 'granteeBrandId', issue: 'grant_exists' }]);
    const id = newId('assetGrant');
    await grantsRepo.create(
      {
        id,
        brandId: a.brandId,
        assetId: a.id,
        granteeBrandId: parsed.granteeBrandId,
        purpose: parsed.purpose,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        createdByUserId: actor.id,
      },
      tx,
    );
    await audit.record(actorRef(actor), 'asset.grant_created', { type: 'asset_grant', id }, 'allowed', tx, {
      brandId: a.brandId,
    });
    return { grantId: id };
  },

  /** Spec 9.3: the media endpoint re-checks authorisation and returns a 5-minute signed GET. */
  async signedUrl(actor: ResolvedActor, input: z.infer<typeof MediaSignedUrlRequest>, tx?: Tx) {
    const parsed = MediaSignedUrlRequest.parse(input);
    const v = await versionsRepo.getById(parsed.assetVersionId, tx);
    const a = await assetsRepo.getById(v.assetId, tx);
    await policy.assert(actor, 'asset.read', assetResource(a), {}, tx);
    let key = v.storageKey;
    let mime = v.mime;
    if (parsed.derivative !== 'original') {
      const d = await derivativesRepo.find(v.id, parsed.derivative, tx);
      if (!d) throw new NotFoundError('AssetDerivative', `${v.id}/${parsed.derivative}`);
      key = d.storageKey;
      mime = d.mime;
    }
    const signed = await storage().signDownloadUrl(key, { expiresInSec: SIGNED_URL_TTL_SEC });
    return { url: signed.url, expiresAt: signed.expiresAt, mime };
  },

  /**
   * Spec 9.3: providers that fetch public URLs get a release derivative copied to the releases/ path with a signed
   * URL covering the provider's processing window. Minted at dispatch (after authoriseUse), never at scheduling.
   */
  async releaseDerivative(
    assetVersionId: string,
    providerProcessingWindowSec: number,
    opts: { derivative?: 'original' | DerivativePurpose } = {},
    tx?: Tx,
  ) {
    const v = await versionsRepo.findInTenant(assetVersionId, tx);
    if (!v) throw new NotFoundError('AssetVersion', assetVersionId);
    let source = {
      key: v.storageKey,
      mime: v.mime,
      contentHash: v.contentHash,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
    };
    const which = opts.derivative ?? 'original';
    if (which !== 'original') {
      const d = await derivativesRepo.find(v.id, which, tx);
      if (!d) throw new NotFoundError('AssetDerivative', `${v.id}/${which}`);
      source = {
        key: d.storageKey,
        mime: d.mime,
        contentHash: d.contentHash,
        width: d.width,
        height: d.height,
        bytes: d.bytes,
      };
    }
    const { tenantId } = requireTenant();
    const id = newId('assetDerivative');
    const releaseKey = storageKeys.release(tenantId, v.brandId, v.id, which, id);
    await storage().copyObject(source.key, releaseKey);
    await derivativesRepo.createRelease(
      {
        id,
        brandId: v.brandId,
        assetVersionId: v.id,
        purpose: 'release',
        transform: { source: which, windowSec: providerProcessingWindowSec },
        storageKey: releaseKey,
        contentHash: source.contentHash,
        mime: source.mime,
        width: source.width,
        height: source.height,
        bytes: source.bytes,
      },
      tx,
    );
    const signed = await storage().signDownloadUrl(releaseKey, { expiresInSec: providerProcessingWindowSec });
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      storageKey: releaseKey,
      contentHash: source.contentHash,
      mime: source.mime,
    };
  },

  /**
   * Spec 9.3 / 14.3 for a rendered export (an object under the tenant prefix that is not an asset version): the
   * bytes are re-read and re-hashed against the hash the approval binding pinned (spec 3.g4) before a release
   * copy is minted with a signed URL covering the provider's processing window. A mismatch is a
   * ReleaseIntegrityError: nothing is minted and the caller holds the publication. Audited in the caller's
   * transaction (or its own) as the tenant context's actor.
   */
  async releaseExport(
    input: {
      brandId: string;
      exportId: string;
      storageKey: string;
      contentHash: string;
      mime: string;
      width: number;
      height: number;
      bytes: number;
    },
    providerProcessingWindowSec: number,
    tx?: Tx,
  ) {
    const { tenantId } = requireTenant();
    const bytes = await storage().getObject(input.storageKey);
    if (!bytes) throw new NotFoundError('RenderedExportObject', input.storageKey);
    const actual = sha256(bytes);
    if (actual !== input.contentHash || bytes.length !== input.bytes)
      throw new ReleaseIntegrityError(input.storageKey, input.contentHash, actual);
    const id = newId('assetDerivative');
    const releaseKey = storageKeys.release(tenantId, input.brandId, input.exportId, 'export', id);
    await storage().copyObject(input.storageKey, releaseKey);
    const signed = await storage().signDownloadUrl(releaseKey, {
      expiresInSec: providerProcessingWindowSec,
    });
    await withTransaction(tx, (t) =>
      audit.record(
        requireTenant().actor,
        'asset.release_minted',
        { type: 'rendered_export', id: input.exportId },
        'allowed',
        t,
        { brandId: input.brandId, path: releaseKey, reason: `window:${providerProcessingWindowSec}s` },
      ),
    );
    return {
      url: signed.url,
      expiresAt: signed.expiresAt,
      storageKey: releaseKey,
      contentHash: input.contentHash,
      mime: input.mime,
      width: input.width,
      height: input.height,
      bytes: input.bytes,
    };
  },
};
