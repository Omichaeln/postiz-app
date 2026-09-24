import type { z } from 'zod';
import {
  BriefAccept,
  BriefCreate,
  BriefGet,
  BriefList,
  CalendarRange,
  CampaignCreate,
  CampaignGet,
  CampaignList,
  ChannelVariantGenerate,
  ChannelVariantGet,
  ChannelVariantUpdate,
  ContentPackageCreate,
  ContentPackageGet,
  ContentPackageRevise,
  ContentRevisionGet,
  CopyDocumentV1,
  type CalendarPublication,
  type ContentClass,
} from '@oremedia/contracts/content';
import { NotFoundError, ValidationFailedError, type ErrorDetail } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ChannelVariantForPublishing } from '@oremedia/contracts/publishing';
import { requireTenant, type Tx } from '@oremedia/db';
import { hashCanonical, hashText } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { briefMachine } from '@oremedia/domain/state-machines/brief';
import { contentPackageMachine } from '@oremedia/domain/state-machines/content-package';
import {
  contentRevisionMachine,
  type ContentRevisionEvent,
} from '@oremedia/domain/state-machines/content-revision';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { policy } from '@oremedia/module-access';
import { ApprovedFactRepository, BrandObjectiveRepository, brandService } from '@oremedia/module-brand';
import {
  CreativeDocumentRepository,
  CreativeRevisionRepository,
  RenderedExportRepository,
  creativeService,
} from '@oremedia/module-creative';
import { audit, outbox } from '@oremedia/module-operations';
import {
  BriefRepository,
  CampaignRepository,
  ChannelVariantRepository,
  ContentPackageRepository,
  ContentRevisionRepository,
} from './repositories';

const campaignsRepo = new CampaignRepository();
const briefsRepo = new BriefRepository();
const packagesRepo = new ContentPackageRepository();
const revisionsRepo = new ContentRevisionRepository();
const variantsRepo = new ChannelVariantRepository();
// Read-only views of other modules' rows through their public index (spec 4.2: never their tables).
const creativeDocumentsRepo = new CreativeDocumentRepository();
const creativeRevisionsRepo = new CreativeRevisionRepository();
const exportsRepo = new RenderedExportRepository();
const factsRepo = new ApprovedFactRepository();
const objectivesRepo = new BrandObjectiveRepository();

type CampaignRow = Awaited<ReturnType<typeof campaignsRepo.getById>>;
type BriefRow = Awaited<ReturnType<typeof briefsRepo.getById>>;
type PackageRow = Awaited<ReturnType<typeof packagesRepo.getById>>;
type RevisionRow = Awaited<ReturnType<typeof revisionsRepo.getById>>;
type VariantRow = Awaited<ReturnType<typeof variantsRepo.getById>>;

// ---- cross-module hooks (same pattern as the creative module's registerAssetAuthoriser) ----

/** Channel connections are publishing rows; the publishing module registers how to describe one (spec 4.2). */
export interface ChannelDescription {
  brandId: string;
  providerKey: string;
  capabilityVersion: number;
}
export type ChannelResolver = (channelConnectionId: string, tx?: Tx) => Promise<ChannelDescription | null>;
const unregisteredChannelResolver: ChannelResolver = async () => {
  throw new Error('channel resolver not registered (composition root must call registerChannelResolver)');
};
let channelResolver: ChannelResolver = unregisteredChannelResolver;
export const registerChannelResolver = (fn: ChannelResolver): void => {
  channelResolver = fn;
};
/** Test seam: back to the loud default. */
export const resetChannelResolver = (): void => {
  channelResolver = unregisteredChannelResolver;
};

/** calendar.range reads publications through the publishing module; until it registers, the calendar shows packages only. */
export type CalendarSource = (
  brandId: string,
  from: Date,
  to: Date,
  tx?: Tx,
) => Promise<CalendarPublication[]>;
let calendarSource: CalendarSource = async () => [];
export const registerCalendarSource = (fn: CalendarSource): void => {
  calendarSource = fn;
};

/**
 * Spec 13.3: a package change after a request froze its manifest marks the request stale, and spec 13.2's
 * approvals.invalidateFor* hooks invalidate approvals eagerly. The review module registers one listener; the
 * content module calls it inside the changing command's transaction.
 */
export interface RevisionChange {
  contentRevisionId: string;
  contentPackageId: string;
  brandId: string;
  reason: 'package_revised' | 'variant_changed';
}
export type RevisionChangeListener = (change: RevisionChange, tx: Tx) => Promise<void>;
const revisionChangeListeners: RevisionChangeListener[] = [];
export const registerRevisionChangeListener = (fn: RevisionChangeListener): void => {
  revisionChangeListeners.push(fn);
};
async function notifyRevisionChange(change: RevisionChange, tx: Tx): Promise<void> {
  for (const listener of revisionChangeListeners) await listener(change, tx);
}

// ---- helpers ----

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
/** A package is never edited in place (revising inserts a revision), so its policy resource carries no state. */
const packageResource = (p: PackageRow) => ({
  type: 'content_package',
  tenantId: p.tenantId,
  brandId: p.brandId,
  id: p.id,
});
/** Variants belong to a revision: editing them is editing the revision, whose state the policy guards (spec 5.5 step 5). */
const revisionResource = (r: RevisionRow) => ({
  type: 'content_revision',
  tenantId: r.tenantId,
  brandId: r.brandId,
  id: r.id,
  state: r.state,
  authorPrincipalId: r.authorId,
});

const authorKindOf = (actor: ResolvedActor): 'user' | 'agent' =>
  actor.kind === 'service_principal' ? 'agent' : 'user';

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
  path: string,
): S {
  try {
    return machine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/** Brand-owned rows are loaded through the scoped repository and bound to the brand: a foreign or mismatched id is NOT_FOUND. */
async function loadCampaign(brandId: string, campaignId: string, tx?: Tx) {
  const c = await campaignsRepo.getById(campaignId, tx);
  if (c.brandId !== brandId) throw new NotFoundError('Campaign', campaignId);
  return c;
}
async function loadBrief(brandId: string, briefId: string, tx?: Tx) {
  const b = await briefsRepo.getById(briefId, tx);
  if (b.brandId !== brandId) throw new NotFoundError('Brief', briefId);
  return b;
}
async function loadRevision(pkg: PackageRow, revisionId: string, tx?: Tx) {
  const r = await revisionsRepo.getById(revisionId, tx);
  if (r.packageId !== pkg.id || r.brandId !== pkg.brandId)
    throw new NotFoundError('ContentRevision', revisionId);
  return r;
}
async function loadCurrentRevision(pkg: PackageRow, tx?: Tx) {
  if (!pkg.currentRevisionId) throw new NotFoundError('ContentRevision', pkg.id);
  return loadRevision(pkg, pkg.currentRevisionId, tx);
}

/**
 * Spec 8.3 / 13.2: the brand snapshot a revision is written against. A brand needs a published version and an
 * active policy version before content can be packaged: the approval binding records both ids.
 */
async function resolveSnapshot(actor: ResolvedActor, brandId: string, tx?: Tx) {
  let snapshot;
  try {
    snapshot = await brandService.resolveBrandSnapshot(actor, { brandId }, tx);
  } catch (err) {
    if (err instanceof NotFoundError && err.resourceType === 'PublishedBrandVersion')
      throw new ValidationFailedError(
        [{ path: 'brandId', issue: 'brand_has_no_published_version' }],
        'The brand has no published version to write against',
      );
    throw err;
  }
  if (!snapshot.policyVersionId)
    throw new ValidationFailedError(
      [{ path: 'brandId', issue: 'brand_has_no_active_policy' }],
      'The brand has no active release policy; activate one before packaging content',
    );
  return { ...snapshot, policyVersionId: snapshot.policyVersionId };
}

/** Every fact the copy cites must be effective in the snapshot (approved, inside its validity window). */
function assertFactsEffective(
  copy: CopyDocumentV1,
  snapshot: { facts: ReadonlyArray<{ id: string }> },
): void {
  const effective = new Set(snapshot.facts.map((f) => f.id));
  const details: ErrorDetail[] = copy.master.factRefs
    .map((id, i) => ({ id, i }))
    .filter(({ id }) => !effective.has(id))
    .map(({ i }) => ({ path: `copy.master.factRefs.${i}`, issue: 'fact_not_effective' }));
  if (details.length) throw new ValidationFailedError(details, 'The copy cites facts that are not approved');
}

/**
 * The creative documents a revision publishes with must belong to the brand; the revision pins each document's
 * current creative revision (spec 6.3 content_revisions.creative_revision_ids), never the document.
 */
async function pinCreativeRevisions(
  actor: ResolvedActor,
  brandId: string,
  documentIds: readonly string[],
  tx: Tx,
): Promise<string[]> {
  const pinned: string[] = [];
  for (const [i, documentId] of [...new Set(documentIds)].entries()) {
    const doc = await creativeService.documents.get(actor, { documentId }, tx); // foreign → NOT_FOUND
    if (doc.brandId !== brandId)
      throw new ValidationFailedError([{ path: `creativeDocumentIds.${i}`, issue: 'document_not_in_brand' }]);
    pinned.push(doc.revision.id);
  }
  return pinned;
}

const revisionContentHash = (input: {
  copy: CopyDocumentV1;
  creativeRevisionIds: string[];
  factRefs: string[];
  brandVersionId: string;
  policyVersionId: string;
}) => hashCanonical(input);

/** Rendered exports by id, in the variant's order (spec 13.2 exportHashes: exact files, in order); a missing export is NOT_FOUND. */
async function exportHashesFor(brandId: string, exportIds: readonly string[], tx?: Tx): Promise<string[]> {
  if (exportIds.length === 0) return [];
  const rows = await exportsRepo.listByIds(brandId, exportIds, tx);
  const byId = new Map(rows.map((e) => [e.id, e.contentHash]));
  return exportIds.map((id) => {
    const hash = byId.get(id);
    if (!hash) throw new NotFoundError('RenderedExport', id);
    return hash;
  });
}

/**
 * Spec 13.2 target hashes, shared by the frozen manifest and the approval binding so both are computed one way:
 * caption NFC-normalised and trailing-trimmed, alt texts likewise, provider settings as canonical JSON, export
 * hashes in order.
 */
export const hashesForVariant = (v: {
  text: string;
  altTexts: readonly string[];
  settings: Record<string, unknown>;
  exportHashes: readonly string[];
}) => ({
  textHash: hashText(v.text),
  altTextHashes: v.altTexts.map(hashText),
  settingsHash: hashCanonical(v.settings),
  exportHashes: [...v.exportHashes],
});

/** Spec 13.4 classOf(pub): a revision citing an offer or price fact is `offer`; everything else is `general`. */
export const contentClassOf = (referencedFactKinds: readonly string[]): ContentClass =>
  referencedFactKinds.some((k) => k === 'offer' || k === 'price') ? 'offer' : 'general';

// ---- DTO mappers: JSON documents are validated on read as well as on write (spec 6.1) ----

const toCampaignDto = (c: CampaignRow) => ({
  id: c.id,
  brandId: c.brandId,
  objectiveId: c.objectiveId,
  name: c.name,
  startsAt: c.startsAt.toISOString(),
  endsAt: c.endsAt.toISOString(),
  state: c.state,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
  version: c.version,
});
const toBriefDto = (b: BriefRow) => ({
  id: b.id,
  brandId: b.brandId,
  campaignId: b.campaignId,
  audience: b.audience,
  message: b.message,
  offerFactIds: b.offerFactIds,
  channelConnectionIds: b.channelConnectionIds,
  constraints: b.constraints,
  state: b.state,
  createdByKind: b.createdByKind,
  createdById: b.createdById,
  agentRunId: b.agentRunId,
  recommendationId: b.recommendationId,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
  version: b.version,
});
const toPackageDto = (p: PackageRow) => ({
  id: p.id,
  brandId: p.brandId,
  briefId: p.briefId,
  title: p.title,
  currentRevisionId: p.currentRevisionId,
  state: p.state,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  version: p.version,
});
const toRevisionDto = (r: RevisionRow) => ({
  id: r.id,
  tenantId: r.tenantId,
  brandId: r.brandId,
  contentPackageId: r.packageId,
  number: r.number,
  brandVersionId: r.brandVersionId,
  policyVersionId: r.policyVersionId,
  copy: CopyDocumentV1.parse(r.copy),
  creativeRevisionIds: r.creativeRevisionIds,
  factRefs: r.factRefs,
  contentHash: r.contentHash,
  state: r.state,
  authorKind: r.authorKind,
  authorId: r.authorId,
  agentRunId: r.agentRunId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
});
export type ContentRevisionDto = ReturnType<typeof toRevisionDto>;
const toRevisionSummary = (r: RevisionRow) => {
  const { copy: _copy, ...summary } = toRevisionDto(r);
  return summary;
};
/** The publishing shape (contracts ChannelVariantForPublishing) plus the row's remaining columns. */
async function toVariantDto(
  v: VariantRow,
  contentPackageId: string,
  tx?: Tx,
): Promise<ChannelVariantForPublishing & Record<string, unknown>> {
  return {
    id: v.id,
    tenantId: v.tenantId,
    brandId: v.brandId,
    contentPackageId,
    contentRevisionId: v.contentRevisionId,
    channelConnectionId: v.channelConnectionId,
    text: v.text,
    altTexts: v.altTexts,
    settings: v.settings,
    exportIds: v.exportIds,
    exportHashes: await exportHashesFor(v.brandId, v.exportIds, tx),
    capabilityVersion: v.capabilityVersion,
    validation: v.validation,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    version: v.version,
  };
}
export type ChannelVariantDto = Awaited<ReturnType<typeof toVariantDto>>;

/** Inserts revision n and points the package at it; shared by create (n = 1) and revise (n = current + 1). */
async function insertRevision(
  actor: ResolvedActor,
  pkg: { id: string; brandId: string; version: number; state: PackageRow['state'] },
  input: {
    number: number;
    copy: CopyDocumentV1;
    creativeRevisionIds: string[];
    brandVersionId: string;
    policyVersionId: string;
    packageState: PackageRow['state'];
  },
  tx: Tx,
) {
  const factRefs = [...new Set(input.copy.master.factRefs)];
  const contentHash = revisionContentHash({
    copy: input.copy,
    creativeRevisionIds: input.creativeRevisionIds,
    factRefs,
    brandVersionId: input.brandVersionId,
    policyVersionId: input.policyVersionId,
  });
  const revisionId = newId('contentRevision');
  await revisionsRepo.create(
    {
      id: revisionId,
      brandId: pkg.brandId,
      packageId: pkg.id,
      number: input.number,
      brandVersionId: input.brandVersionId,
      policyVersionId: input.policyVersionId,
      copy: input.copy,
      creativeRevisionIds: input.creativeRevisionIds,
      factRefs,
      contentHash,
      state: 'draft',
      authorKind: authorKindOf(actor),
      authorId: actor.id,
      agentRunId: null,
    },
    tx,
  );
  await packagesRepo.update(
    pkg.id,
    pkg.version,
    { currentRevisionId: revisionId, state: input.packageState },
    tx,
  );
  await outbox.add(
    'content.revision_created',
    { type: 'content_package', id: pkg.id, version: pkg.version + 1 },
    {
      contentPackageId: pkg.id,
      contentRevisionId: revisionId,
      number: input.number,
      contentHash,
      brandVersionId: input.brandVersionId,
    },
    tx,
    { brandId: pkg.brandId },
  );
  return { revisionId, contentHash };
}

export const contentService = {
  campaigns: {
    async create(actor: ResolvedActor, input: z.infer<typeof CampaignCreate>, tx: Tx) {
      const parsed = CampaignCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx); // a foreign or invisible brand is NOT_FOUND
      await policy.assert(actor, 'content.plan', brandResource(brand.id), {}, tx);
      const startsAt = new Date(parsed.startsAt);
      const endsAt = new Date(parsed.endsAt);
      if (endsAt.getTime() < startsAt.getTime())
        throw new ValidationFailedError([{ path: 'endsAt', issue: 'must not be before startsAt' }]);
      if (parsed.objectiveId) {
        const objective = await objectivesRepo.getById(parsed.objectiveId, tx);
        if (objective.brandId !== brand.id) throw new NotFoundError('BrandObjective', parsed.objectiveId);
      }
      const id = newId('campaign');
      await campaignsRepo.create(
        {
          id,
          brandId: brand.id,
          objectiveId: parsed.objectiveId ?? null,
          name: parsed.name,
          startsAt,
          endsAt,
          state: 'draft',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'content.campaign.create',
        { type: 'campaign', id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { campaignId: id, state: 'draft' as const, version: 0 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof CampaignList>, tx?: Tx) {
      const parsed = CampaignList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      const page = await campaignsRepo.list(brand.id, parsed.page, tx);
      return { items: page.items.map(toCampaignDto), nextCursor: page.nextCursor };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof CampaignGet>, tx?: Tx) {
      const parsed = CampaignGet.parse(input);
      const campaign = await campaignsRepo.getById(parsed.campaignId, tx);
      await policy.assert(actor, 'brand.read', brandResource(campaign.brandId), {}, tx);
      return toCampaignDto(campaign);
    },
  },

  briefs: {
    /** Spec 6.3 briefs: audience, message, offer facts (must exist on the brand), planned channels and constraints. */
    async create(actor: ResolvedActor, input: z.infer<typeof BriefCreate>, tx: Tx) {
      const parsed = BriefCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'content.plan', brandResource(brand.id), {}, tx);
      if (parsed.campaignId) await loadCampaign(brand.id, parsed.campaignId, tx);
      for (const [i, factId] of parsed.offerFactIds.entries()) {
        const fact = await factsRepo.getById(factId, tx);
        if (fact.brandId !== brand.id)
          throw new ValidationFailedError([{ path: `offerFactIds.${i}`, issue: 'fact_not_in_brand' }]);
      }
      const id = newId('brief');
      await briefsRepo.create(
        {
          id,
          brandId: brand.id,
          campaignId: parsed.campaignId ?? null,
          audience: parsed.audience,
          message: parsed.message,
          offerFactIds: parsed.offerFactIds,
          channelConnectionIds: parsed.channelConnectionIds,
          constraints: parsed.constraints,
          state: 'draft',
          createdByKind: authorKindOf(actor),
          createdById: actor.id,
          agentRunId: null,
          recommendationId: null,
        },
        tx,
      );
      await audit.record(actorRef(actor), 'content.brief.create', { type: 'brief', id }, 'allowed', tx, {
        brandId: brand.id,
      });
      return { briefId: id, state: 'draft' as const, version: 0 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof BriefList>, tx?: Tx) {
      const parsed = BriefList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      if (parsed.campaignId) await loadCampaign(brand.id, parsed.campaignId, tx);
      const page = await briefsRepo.list(brand.id, parsed.campaignId, parsed.page, tx);
      return { items: page.items.map(toBriefDto), nextCursor: page.nextCursor };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof BriefGet>, tx?: Tx) {
      const parsed = BriefGet.parse(input);
      const brief = await briefsRepo.getById(parsed.briefId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brief.brandId), {}, tx);
      return toBriefDto(brief);
    },

    /** Spec 21.2 campaign planner "accepted plan": draft → accepted, by briefMachine. */
    async accept(actor: ResolvedActor, input: z.infer<typeof BriefAccept>, tx: Tx) {
      const parsed = BriefAccept.parse(input);
      const brief = await briefsRepo.getById(parsed.briefId, tx);
      await policy.assert(actor, 'content.plan', brandResource(brief.brandId), {}, tx);
      const toState = transition(briefMachine, brief.state, 'accept', 'briefId');
      await briefsRepo.update(brief.id, parsed.expectedVersion, { state: toState }, tx);
      await audit.record(
        actorRef(actor),
        'content.brief.accept',
        { type: 'brief', id: brief.id },
        'allowed',
        tx,
        { brandId: brief.brandId, fromState: brief.state, toState, expectedVersion: parsed.expectedVersion },
      );
      return { briefId: brief.id, state: toState, version: parsed.expectedVersion + 1 };
    },
  },

  packages: {
    /**
     * A package is born with content revision 1 in the same transaction: the copy, the pinned creative revisions,
     * and the brand's published version and active policy version (spec 6.3 content_revisions). Every fact the
     * copy cites must be effective. An accepted brief moves to in_progress.
     */
    async create(actor: ResolvedActor, input: z.infer<typeof ContentPackageCreate>, tx: Tx) {
      const parsed = ContentPackageCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'content.edit', brandResource(brand.id), {}, tx);
      const brief = parsed.briefId ? await loadBrief(brand.id, parsed.briefId, tx) : null;
      const snapshot = await resolveSnapshot(actor, brand.id, tx);
      assertFactsEffective(parsed.copy, snapshot);
      const creativeRevisionIds = await pinCreativeRevisions(actor, brand.id, parsed.creativeDocumentIds, tx);
      const packageId = newId('contentPackage');
      await packagesRepo.create(
        {
          id: packageId,
          brandId: brand.id,
          briefId: brief?.id ?? null,
          title: parsed.title,
          currentRevisionId: null,
          state: 'draft',
        },
        tx,
      );
      const { revisionId, contentHash } = await insertRevision(
        actor,
        { id: packageId, brandId: brand.id, version: 0, state: 'draft' },
        {
          number: 1,
          copy: parsed.copy,
          creativeRevisionIds,
          brandVersionId: snapshot.brandVersionId,
          policyVersionId: snapshot.policyVersionId,
          packageState: 'draft',
        },
        tx,
      );
      if (brief && brief.state === 'accepted')
        await briefsRepo.update(
          brief.id,
          brief.version,
          { state: transition(briefMachine, brief.state, 'start', 'briefId') },
          tx,
        );
      await audit.record(
        actorRef(actor),
        'content.package.create',
        { type: 'content_package', id: packageId },
        'allowed',
        tx,
        { brandId: brand.id, revisionId },
      );
      return {
        contentPackageId: packageId,
        contentRevisionId: revisionId,
        number: 1,
        contentHash,
        brandVersionId: snapshot.brandVersionId,
        policyVersionId: snapshot.policyVersionId,
        state: 'draft' as const,
        version: 1,
      };
    },

    /**
     * Spec 13.1: a revision is never edited. Revising locks the package, inserts revision n+1 (draft) against the
     * brand's *current* published version and policy, supersedes the current revision whatever its state, and
     * notifies the review module: an open request on the old revision goes stale (spec 13.3). An approval bound
     * to the old revision keeps binding that revision; the package's current content is no longer what it approved.
     */
    async revise(actor: ResolvedActor, input: z.infer<typeof ContentPackageRevise>, tx: Tx) {
      const parsed = ContentPackageRevise.parse(input);
      const pkg = await packagesRepo.lock(parsed.contentPackageId, tx);
      await policy.assert(actor, 'content.edit', packageResource(pkg), {}, tx);
      const packageState = transition(contentPackageMachine, pkg.state, 'revise', 'contentPackageId');
      const current = await loadCurrentRevision(pkg, tx);
      const snapshot = await resolveSnapshot(actor, pkg.brandId, tx);
      assertFactsEffective(parsed.copy, snapshot);
      const creativeRevisionIds = await pinCreativeRevisions(
        actor,
        pkg.brandId,
        parsed.creativeDocumentIds,
        tx,
      );
      const superseded = transition(contentRevisionMachine, current.state, 'supersede', 'contentPackageId');
      const number = await revisionsRepo.nextNumber(pkg.brandId, pkg.id, tx);
      await revisionsRepo.setState(current.id, current.version, superseded, tx);
      const { revisionId, contentHash } = await insertRevision(
        actor,
        { ...pkg, version: parsed.expectedVersion },
        {
          number,
          copy: parsed.copy,
          creativeRevisionIds,
          brandVersionId: snapshot.brandVersionId,
          policyVersionId: snapshot.policyVersionId,
          packageState,
        },
        tx,
      );
      await notifyRevisionChange(
        {
          contentRevisionId: current.id,
          contentPackageId: pkg.id,
          brandId: pkg.brandId,
          reason: 'package_revised',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'content.package.revise',
        { type: 'content_revision', id: revisionId },
        'allowed',
        tx,
        {
          brandId: pkg.brandId,
          revisionId,
          fromState: current.state,
          toState: superseded,
          expectedVersion: parsed.expectedVersion,
        },
      );
      return {
        contentPackageId: pkg.id,
        contentRevisionId: revisionId,
        supersededRevisionId: current.id,
        number,
        contentHash,
        state: packageState,
        version: parsed.expectedVersion + 1,
      };
    },

    /** The package, its current revision with variants, and its revision history (newest first, without copy). */
    async get(actor: ResolvedActor, input: z.infer<typeof ContentPackageGet>, tx?: Tx) {
      const parsed = ContentPackageGet.parse(input);
      const pkg = await packagesRepo.getById(parsed.contentPackageId, tx);
      await policy.assert(actor, 'brand.read', brandResource(pkg.brandId), {}, tx);
      const current = await loadCurrentRevision(pkg, tx);
      const variants = await variantsRepo.listForRevision(pkg.brandId, current.id, tx);
      const history = await revisionsRepo.listForPackage(pkg.brandId, pkg.id, tx);
      const variantDtos = [];
      for (const v of variants) variantDtos.push(await toVariantDto(v, pkg.id, tx));
      return {
        ...toPackageDto(pkg),
        revision: toRevisionDto(current),
        variants: variantDtos,
        revisions: history.map(toRevisionSummary),
      };
    },
  },

  revisions: {
    /** The revision as the review and publishing modules read it (spec 14.1); brand.read. */
    async get(actor: ResolvedActor, input: z.infer<typeof ContentRevisionGet>, tx?: Tx) {
      const parsed = ContentRevisionGet.parse(input);
      const revision = await revisionsRepo.getById(parsed.revisionId, tx);
      await policy.assert(actor, 'brand.read', brandResource(revision.brandId), {}, tx);
      return toRevisionDto(revision);
    },

    /**
     * Tenant- and brand-scoped read without a policy decision, for the review and publishing modules at the point
     * of effect (release evaluation, manifest freezing) where the calling command has already asserted its own action.
     */
    async read(revisionId: string, tx?: Tx) {
      return toRevisionDto(await revisionsRepo.getById(revisionId, tx));
    },

    /**
     * Spec 11.4 approvals.invalidateForCreativeRevisionChange: the revisions (in review or approved) that pin any
     * revision of the changed creative document.
     */
    async listReferencingCreativeDocument(documentId: string, tx?: Tx) {
      const doc = await creativeDocumentsRepo.getById(documentId, tx);
      const creativeRevisionIds = new Set(
        (await creativeRevisionsRepo.list(doc.brandId, doc.id, { limit: 200 }, tx)).items.map((r) => r.id),
      );
      const candidates = await revisionsRepo.listInStates(doc.brandId, ['in_review', 'approved'], tx);
      return candidates
        .filter((r) => r.creativeRevisionIds.some((id) => creativeRevisionIds.has(id)))
        .map(toRevisionSummary);
    },

    /**
     * Spec 13.1: the review module moves a revision only through contentRevisionMachine, and the package follows
     * (draft → in_review → approved | draft). The caller has asserted review.request / review.decide.
     */
    async transition(revisionId: string, event: Exclude<ContentRevisionEvent, 'supersede'>, tx: Tx) {
      const revision = await revisionsRepo.getById(revisionId, tx);
      const toState = transition(contentRevisionMachine, revision.state, event, 'contentRevisionId');
      await revisionsRepo.setState(revision.id, revision.version, toState, tx);
      const pkg = await packagesRepo.getById(revision.packageId, tx);
      if (pkg.currentRevisionId === revision.id && event !== 'reopen') {
        const packageState = transition(contentPackageMachine, pkg.state, event, 'contentRevisionId');
        if (packageState !== pkg.state)
          await packagesRepo.update(pkg.id, pkg.version, { state: packageState }, tx);
      }
      await audit.record(
        requireTenant().actor,
        'content.revision.transition',
        { type: 'content_revision', id: revision.id },
        'allowed',
        tx,
        { brandId: revision.brandId, revisionId: revision.id, fromState: revision.state, toState },
      );
      return { revisionId: revision.id, fromState: revision.state, toState, version: revision.version + 1 };
    },
  },

  variants: {
    /**
     * Spec 14.1: one variant per (revision, channel connection). The master copy is the caption (per-channel
     * adaptation is a Phase 4 skill), alt texts come from the creative documents' titles, provider settings start
     * empty, and the export ids are the revision's pinned creative revisions' ready exports, in id order. Existing
     * targets are returned untouched.
     */
    async generate(actor: ResolvedActor, input: z.infer<typeof ChannelVariantGenerate>, tx: Tx) {
      const parsed = ChannelVariantGenerate.parse(input);
      const revision = await revisionsRepo.getById(parsed.contentRevisionId, tx);
      await policy.assert(actor, 'content.edit', revisionResource(revision), {}, tx);
      const copy = CopyDocumentV1.parse(revision.copy);
      const exportIds: string[] = [];
      const altTexts: string[] = [];
      for (const creativeRevisionId of revision.creativeRevisionIds) {
        const creativeRevision = await creativeRevisionsRepo.getById(creativeRevisionId, tx);
        const doc = await creativeDocumentsRepo.getById(creativeRevision.documentId, tx);
        for (const e of await exportsRepo.listForRevision(revision.brandId, creativeRevision.id, tx)) {
          exportIds.push(e.id);
          altTexts.push(doc.title);
        }
      }
      const existing = new Map(
        (await variantsRepo.listForRevision(revision.brandId, revision.id, tx)).map((v) => [
          v.channelConnectionId,
          v,
        ]),
      );
      const created: string[] = [];
      const variants = [];
      for (const [i, channelConnectionId] of [...new Set(parsed.channelConnectionIds)].entries()) {
        const found = existing.get(channelConnectionId);
        if (found) {
          variants.push(await toVariantDto(found, revision.packageId, tx));
          continue;
        }
        const channel = await channelResolver(channelConnectionId, tx);
        if (!channel || channel.brandId !== revision.brandId)
          throw new NotFoundError('ChannelConnection', channelConnectionId); // never reveal another brand's channel
        const id = newId('channelVariant');
        await variantsRepo.create(
          {
            id,
            brandId: revision.brandId,
            contentRevisionId: revision.id,
            channelConnectionId,
            text: copy.master.text,
            altTexts,
            settings: {},
            exportIds,
            capabilityVersion: channel.capabilityVersion,
            validation: { ok: true, issues: [] },
          },
          tx,
        );
        created.push(id);
        variants.push(await toVariantDto(await variantsRepo.getById(id, tx), revision.packageId, tx));
        await audit.record(
          actorRef(actor),
          'content.variant.generate',
          { type: 'channel_variant', id },
          'allowed',
          tx,
          {
            brandId: revision.brandId,
            revisionId: revision.id,
            channelConnectionId,
            path: `channelConnectionIds.${i}`,
          },
        );
      }
      if (created.length)
        await notifyRevisionChange(
          {
            contentRevisionId: revision.id,
            contentPackageId: revision.packageId,
            brandId: revision.brandId,
            reason: 'variant_changed',
          },
          tx,
        );
      return { contentRevisionId: revision.id, created, variants };
    },

    /**
     * Caption, alt texts, settings and export selection, with an optimistic version. Only exports of the revision's
     * pinned creative revisions can be selected. The revision's state guards the edit (spec 5.5 step 5): an
     * approved or in-review revision is never edited; revise the package instead.
     */
    async update(actor: ResolvedActor, input: z.infer<typeof ChannelVariantUpdate>, tx: Tx) {
      const parsed = ChannelVariantUpdate.parse(input);
      const variant = await variantsRepo.getById(parsed.channelVariantId, tx);
      const revision = await revisionsRepo.getById(variant.contentRevisionId, tx);
      await policy.assert(actor, 'content.edit', revisionResource(revision), {}, tx);
      const exportIds = [...new Set(parsed.exportIds)];
      const exports = await exportsRepo.listByIds(revision.brandId, exportIds, tx);
      const pinned = new Set(revision.creativeRevisionIds);
      const byId = new Map(exports.map((e) => [e.id, e]));
      const details: ErrorDetail[] = [];
      exportIds.forEach((id, i) => {
        const e = byId.get(id);
        if (!e) details.push({ path: `exportIds.${i}`, issue: 'export_not_found' });
        else if (!pinned.has(e.revisionId))
          details.push({ path: `exportIds.${i}`, issue: 'export_not_in_revision' });
      });
      if (details.length) throw new ValidationFailedError(details);
      await variantsRepo.update(
        variant.id,
        parsed.expectedVersion,
        { text: parsed.text, altTexts: parsed.altTexts, settings: parsed.settings, exportIds },
        tx,
      );
      await notifyRevisionChange(
        {
          contentRevisionId: revision.id,
          contentPackageId: revision.packageId,
          brandId: revision.brandId,
          reason: 'variant_changed',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'content.variant.update',
        { type: 'channel_variant', id: variant.id },
        'allowed',
        tx,
        {
          brandId: revision.brandId,
          revisionId: revision.id,
          channelConnectionId: variant.channelConnectionId,
          expectedVersion: parsed.expectedVersion,
        },
      );
      return toVariantDto(await variantsRepo.getById(variant.id, tx), revision.packageId, tx);
    },

    /** Spec 14.1: what a publication needs from a variant, with the exports' hashes resolved; brand.read. */
    async get(actor: ResolvedActor, input: z.infer<typeof ChannelVariantGet>, tx?: Tx) {
      const parsed = ChannelVariantGet.parse(input);
      const variant = await variantsRepo.getById(parsed.variantId, tx);
      await policy.assert(actor, 'brand.read', brandResource(variant.brandId), {}, tx);
      const revision = await revisionsRepo.getById(variant.contentRevisionId, tx);
      return toVariantDto(variant, revision.packageId, tx);
    },

    /** Scoped read without a policy decision (see revisions.read). */
    async read(variantId: string, tx?: Tx) {
      const variant = await variantsRepo.getById(variantId, tx);
      const revision = await revisionsRepo.getById(variant.contentRevisionId, tx);
      return toVariantDto(variant, revision.packageId, tx);
    },

    /** Every variant of a revision in channel-connection order, hashes resolved (the binding's targets). */
    async listForRevision(revisionId: string, tx?: Tx) {
      const revision = await revisionsRepo.getById(revisionId, tx);
      const rows = await variantsRepo.listForRevision(revision.brandId, revision.id, tx);
      const out = [];
      for (const v of rows) out.push(await toVariantDto(v, revision.packageId, tx));
      return out;
    },
  },

  calendar: {
    /** Campaigns overlapping the range, packages touched in it, and publications from the publishing module when registered. */
    async range(actor: ResolvedActor, input: z.infer<typeof CalendarRange>, tx?: Tx) {
      const parsed = CalendarRange.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      const from = new Date(parsed.from);
      const to = new Date(parsed.to);
      if (to.getTime() < from.getTime())
        throw new ValidationFailedError([{ path: 'to', issue: 'must not be before from' }]);
      const [campaignRows, packageRows, publications] = await Promise.all([
        campaignsRepo.listOverlapping(brand.id, from, to, tx),
        packagesRepo.listUpdatedBetween(brand.id, from, to, tx),
        calendarSource(brand.id, from, to, tx),
      ]);
      return {
        brandId: brand.id,
        from: from.toISOString(),
        to: to.toISOString(),
        campaigns: campaignRows.map(toCampaignDto),
        packages: packageRows.map(toPackageDto),
        publications,
      };
    },
  },
};
