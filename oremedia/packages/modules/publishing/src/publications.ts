import type { z } from 'zod';
import {
  ApprovalInvalidError,
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import {
  CancelCommand,
  PublicationDeleteRemote,
  PublicationEvidence,
  PublicationGet,
  PublicationList,
  ReconcileCommand,
  RescheduleCommand,
  ScheduleCommand,
  type CancelResult,
  type PublicationForRelease,
  type PublicationState,
} from '@oremedia/contracts/publishing';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { PublicationEvent } from '@oremedia/domain/state-machines/publication';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import {
  actorRef,
  forRelease,
  publicationWorkflowId,
  toAttemptDto,
  toEvidenceDto,
  toPublicationDto,
  transition,
  workflowIdOf,
  type PublicationRow,
} from './common';
import { assertBrandExists, review, variants } from './hooks';
import { registry } from './providers';
import {
  ChannelConnectionRepository,
  PublicationAttemptRepository,
  PublicationRepository,
  RemoteEvidenceRepository,
} from './repositories';

const publicationsRepo = new PublicationRepository();
const attemptsRepo = new PublicationAttemptRepository();
const evidenceRepo = new RemoteEvidenceRepository();
const connectionsRepo = new ChannelConnectionRepository();

/** Policy options the caller may pass through (spec 5.5 step 7): the agent runtime supplies the run's autonomy mode. */
export interface ActorOptions {
  autonomyMode?: AutonomyMode;
}

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const publicationResource = (p: PublicationRow) => ({
  type: 'publication',
  tenantId: p.tenantId,
  brandId: p.brandId,
  id: p.id,
  channelId: p.channelConnectionId,
  state: p.state,
});

/** In-flight states (spec 13.5): a cancel cannot be honoured by the row; the workflow is signalled instead. */
const IN_FLIGHT: ReadonlySet<PublicationState> = new Set(['dispatching', 'processing', 'outcome_unknown']);

const isDuplicateKeyError = (err: unknown): boolean =>
  (err as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY' ||
  (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ER_DUP_ENTRY';

function scheduledByOf(actor: ResolvedActor): 'user' | 'service_principal' {
  if (actor.kind === 'user' || actor.kind === 'service_principal') return actor.kind;
  throw new PolicyDeniedError(
    'actor_kind_cannot_schedule',
    'Only members and agents can schedule publications',
  );
}

/** Spec 5.5: an agent below managed_autopublish carries the requires_approval obligation, so a mandate is refused. */
function assertAuthorityAllowed(decision: Decision, authority: 'approval' | 'mandate'): void {
  if (authority === 'mandate' && decision.obligations?.some((o) => o.type === 'requires_approval'))
    throw new PolicyDeniedError('approval_required', 'This actor may only schedule with a valid approval');
}

async function recordStateChange(
  actor: ResolvedActor,
  action: string,
  row: PublicationRow,
  toState: PublicationState,
  reason: string | null,
  tx: Tx,
): Promise<void> {
  await audit.record(actorRef(actor), action, { type: 'publication', id: row.id }, 'allowed', tx, {
    brandId: row.brandId,
    publicationId: row.id,
    fromState: row.state,
    toState,
    reason,
  });
  await outbox.add(
    'publication.state_changed',
    { type: 'publication', id: row.id, version: row.version + 1 },
    { publicationId: row.id, fromState: row.state, toState, reason },
    tx,
    { brandId: row.brandId },
  );
}

/** A re-release (held/retry_eligible → scheduled) starts a new workflow generation (see publicationWorkflowId). */
async function release(
  actor: ResolvedActor,
  row: PublicationRow,
  event: PublicationEvent,
  scheduledFor: Date,
  tx: Tx,
) {
  const toState = transition(row.state, event, 'publicationId');
  const pre = await review.evaluateRelease(
    { ...forRelease(row), scheduledFor: scheduledFor.toISOString() },
    scheduledFor,
    tx,
  );
  if (!pre.allow) throw new ApprovalInvalidError(pre.reasons);
  const workflowId = publicationWorkflowId(row.id, row.version + 1);
  await publicationsRepo.update(
    row.id,
    row.version,
    {
      state: toState,
      scheduledFor,
      stateReason: null,
      holdReasons: null,
      claimant: workflowId,
      claimedAt: null,
    },
    tx,
  );
  await recordStateChange(actor, 'publication.reschedule', row, toState, 're-released', tx);
  await outbox.add(
    'publication.scheduled',
    { type: 'publication', id: row.id, version: row.version + 1 },
    {
      publicationId: row.id,
      scheduledFor: scheduledFor.toISOString(),
      workflowId,
      rerelease: true,
      actorKind: actor.kind,
      actorId: actor.id,
    },
    tx,
    { brandId: row.brandId },
  );
}

/**
 * Spec 8.2: scheduled rows that fail the release check at their scheduled time move to `held` through the
 * publication machine with the failed checks as reasons; the rest are left as they are. The actor is the tenant
 * context's (the brand publisher the workflow carries, spec 5.2).
 */
async function holdWhereReleaseFails(rows: PublicationRow[], reason: string, tx: Tx) {
  const held: string[] = [];
  const unchanged: string[] = [];
  for (const row of rows) {
    const decision = await review.evaluateRelease(forRelease(row), row.scheduledFor, tx);
    if (decision.allow) {
      unchanged.push(row.id);
      continue;
    }
    const toState = transition(row.state, 'dependency_revoked', 'publicationId');
    await publicationsRepo.update(
      row.id,
      row.version,
      { state: toState, stateReason: reason.slice(0, 120), holdReasons: decision.reasons },
      tx,
    );
    await audit.record(
      requireTenant().actor,
      'publication.hold',
      { type: 'publication', id: row.id },
      'allowed',
      tx,
      {
        brandId: row.brandId,
        publicationId: row.id,
        fromState: row.state,
        toState,
        reason: decision.reasons.join(','),
      },
    );
    await outbox.add(
      'publication.state_changed',
      { type: 'publication', id: row.id, version: row.version + 1 },
      { publicationId: row.id, fromState: row.state, toState, reason },
      tx,
      { brandId: row.brandId },
    );
    held.push(row.id);
  }
  return { held, unchanged };
}

export const publicationService = {
  /**
   * Spec 14.1 schedulePublication, literally: variant through the content hook, policy, fail-fast release
   * pre-check, occurrence key unique per tenant (a repeat is CONFLICT, never a second row), the row in `scheduled`,
   * the outbox event and the audit event in the caller's (idempotent) transaction.
   */
  async schedule(
    actor: ResolvedActor,
    input: z.infer<typeof ScheduleCommand>,
    tx: Tx,
    opts: ActorOptions = {},
  ) {
    const cmd = ScheduleCommand.parse(input);
    const { tenantId } = requireTenant();
    const variant = await variants.get(cmd.channelVariantId, tx);
    if (variant.tenantId !== tenantId) throw new NotFoundError('ChannelVariant', cmd.channelVariantId);
    const connection = await connectionsRepo.getById(variant.channelConnectionId, tx); // foreign → NOT_FOUND
    if (connection.brandId !== variant.brandId)
      throw new ValidationFailedError(
        [{ path: 'channelVariantId', issue: 'channel_belongs_to_another_brand' }],
        'The variant targets a channel of another brand',
      );
    const decision = await policy.assert(
      actor,
      'publication.schedule',
      {
        type: 'channel_variant',
        tenantId,
        brandId: variant.brandId,
        id: variant.id,
        channelId: connection.id,
      },
      opts,
      tx,
    );
    assertAuthorityAllowed(decision, cmd.authority);
    if (cmd.authority === 'approval' && !cmd.approvalId)
      throw new ValidationFailedError([{ path: 'approvalId', issue: 'required_for_approval_authority' }]);
    if (cmd.authority === 'mandate' && !cmd.mandateId)
      throw new ValidationFailedError([{ path: 'mandateId', issue: 'required_for_mandate_authority' }]);
    const scheduledFor = new Date(cmd.scheduledFor);
    const preview: PublicationForRelease = {
      id: 'preview',
      tenantId,
      brandId: variant.brandId,
      contentPackageId: variant.contentPackageId,
      contentRevisionId: variant.contentRevisionId,
      channelVariantId: variant.id,
      channelConnectionId: connection.id,
      authority: cmd.authority,
      approvalId: cmd.approvalId ?? null,
      mandateId: cmd.mandateId ?? null,
      scheduledFor: scheduledFor.toISOString(),
      state: 'scheduled',
    };
    const pre = await review.evaluateRelease(preview, scheduledFor, tx); // fail fast for UX; dispatch re-evaluates
    if (!pre.allow) throw new ApprovalInvalidError(pre.reasons);

    const occurrenceKey = `${variant.contentRevisionId}:${variant.channelConnectionId}:${cmd.occurrence ?? 'once'}`;
    const existing = await publicationsRepo.findByOccurrenceKey(occurrenceKey, tx);
    if (existing) throw new ConflictError('Publication', existing.id, existing.version);
    const id = newId('publication');
    const workflowId = publicationWorkflowId(id, 0);
    try {
      await publicationsRepo.create(
        {
          id,
          brandId: variant.brandId,
          contentPackageId: variant.contentPackageId,
          contentRevisionId: variant.contentRevisionId,
          channelVariantId: variant.id,
          channelConnectionId: connection.id,
          occurrenceKey,
          authority: cmd.authority,
          approvalId: cmd.approvalId ?? null,
          mandateId: cmd.mandateId ?? null,
          scheduledFor,
          state: 'scheduled',
          claimant: workflowId,
          scheduledByKind: scheduledByOf(actor),
          scheduledById: actor.id,
        },
        tx,
      );
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('Publication', occurrenceKey, 0); // lost the race
      throw err;
    }
    await outbox.add(
      'publication.scheduled',
      { type: 'publication', id, version: 1 },
      {
        publicationId: id,
        scheduledFor: scheduledFor.toISOString(),
        workflowId,
        rerelease: false,
        actorKind: actor.kind,
        actorId: actor.id,
      },
      tx,
      { brandId: variant.brandId },
    );
    await audit.record(actorRef(actor), 'publication.schedule', { type: 'publication', id }, 'allowed', tx, {
      brandId: variant.brandId,
      publicationId: id,
      channelConnectionId: connection.id,
      toState: 'scheduled',
    });
    return toPublicationDto(await publicationsRepo.getById(id, tx));
  },

  /**
   * Spec 8.2 brand change impact (brandChangeImpactWorkflowV1): every scheduled publication of the brand is
   * re-evaluated against the release policy at its scheduled time; one that no longer passes moves to `held`
   * with the failed checks as reasons (the machine's dependency_revoked), audited and announced as the tenant
   * context's actor. Idempotent: a held publication is no longer scheduled and is not visited again.
   */
  async reevaluateScheduledForBrand(brandId: string, reason: string, tx: Tx) {
    const rows = await publicationsRepo.listScheduledForBrand(brandId, tx);
    return holdWhereReleaseFails(rows, reason, tx);
  },

  /**
   * Spec 8.2 brand.fact_revoked: the scheduled publications whose content revision cites the fact. With `hold`
   * (policy holdOnDependencyRevocation, the default) each one that fails the release check moves to `held`;
   * without it each is flagged for attention (audit + publication.needs_attention) and keeps its state.
   */
  async applyFactRevocation(
    input: { brandId: string; contentRevisionIds: readonly string[]; factId: string; hold: boolean },
    tx: Tx,
  ) {
    const citing = new Set(input.contentRevisionIds);
    const rows = (await publicationsRepo.listScheduledForBrand(input.brandId, tx)).filter((p) =>
      citing.has(p.contentRevisionId),
    );
    const reason = `fact_revoked:${input.factId}`;
    if (input.hold) return { ...(await holdWhereReleaseFails(rows, reason, tx)), flagged: [] as string[] };
    const flagged: string[] = [];
    for (const row of rows) {
      await audit.record(
        requireTenant().actor,
        'publication.needs_attention',
        { type: 'publication', id: row.id },
        'allowed',
        tx,
        { brandId: row.brandId, publicationId: row.id, revisionId: row.contentRevisionId, reason },
      );
      await outbox.add(
        'publication.needs_attention',
        { type: 'publication', id: row.id, version: row.version },
        { publicationId: row.id, contentRevisionId: row.contentRevisionId, state: row.state, reason },
        tx,
        { brandId: row.brandId },
      );
      flagged.push(row.id);
    }
    return { held: [] as string[], flagged, unchanged: [] as string[] };
  },

  /**
   * Spec 13.5: scheduled → cancelled with the expected version (held resolves to cancelled the same way). Once
   * dispatch started, the row cannot prevent it: the workflow receives a cancel signal through the outbox relay
   * and the outcome is reconciled. Deleting a live remote post is deleteRemote, never an automatic rollback.
   */
  async cancel(actor: ResolvedActor, input: z.infer<typeof CancelCommand>, tx: Tx): Promise<CancelResult> {
    const cmd = CancelCommand.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.cancel', publicationResource(row), {}, tx);
    if (IN_FLIGHT.has(row.state)) {
      await outbox.add(
        'publication.cancel_requested',
        { type: 'publication', id: row.id, version: row.version },
        {
          publicationId: row.id,
          workflowId: workflowIdOf(row),
          requestedByKind: actor.kind,
          requestedById: actor.id,
        },
        tx,
        { brandId: row.brandId },
      );
      await audit.record(
        actorRef(actor),
        'publication.cancel_requested',
        { type: 'publication', id: row.id },
        'allowed',
        tx,
        { brandId: row.brandId, publicationId: row.id, fromState: row.state, reason: 'dispatch_in_progress' },
      );
      return {
        prevented: false,
        state: row.state,
        message: 'Dispatch in progress; outcome will be reconciled',
      };
    }
    if (row.version !== cmd.expectedVersion)
      throw new ConflictError('Publication', row.id, cmd.expectedVersion);
    const event: PublicationEvent = row.state === 'held' ? 'hold_resolved_cancel' : 'user_cancel';
    const toState = transition(row.state, event, 'publicationId');
    await publicationsRepo.update(row.id, row.version, { state: toState, stateReason: 'user_cancel' }, tx);
    await recordStateChange(actor, 'publication.cancel', row, toState, 'user_cancel', tx);
    return { prevented: true, state: toState, version: row.version + 1 };
  },

  /**
   * Spec 14.3: rescheduling updates the row and signals the waiting workflow; it never terminates one. A held or
   * retry_eligible publication is re-released the same way (a new attempt, the same occurrence).
   */
  async reschedule(actor: ResolvedActor, input: z.infer<typeof RescheduleCommand>, tx: Tx) {
    const cmd = RescheduleCommand.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.schedule', publicationResource(row), {}, tx);
    if (row.version !== cmd.expectedVersion)
      throw new ConflictError('Publication', row.id, cmd.expectedVersion);
    const scheduledFor = new Date(cmd.scheduledFor);
    switch (row.state) {
      case 'scheduled': {
        await publicationsRepo.update(row.id, row.version, { scheduledFor }, tx);
        await audit.record(
          actorRef(actor),
          'publication.reschedule',
          { type: 'publication', id: row.id },
          'allowed',
          tx,
          { brandId: row.brandId, publicationId: row.id, fromState: row.state, toState: row.state },
        );
        await outbox.add(
          'publication.rescheduled',
          { type: 'publication', id: row.id, version: row.version + 1 },
          { publicationId: row.id, scheduledFor: scheduledFor.toISOString(), workflowId: workflowIdOf(row) },
          tx,
          { brandId: row.brandId },
        );
        break;
      }
      case 'held':
        await release(actor, row, 'hold_resolved_schedule', scheduledFor, tx);
        break;
      case 'retry_eligible':
        await release(actor, row, 'reschedule', scheduledFor, tx);
        break;
      default:
        throw new ValidationFailedError(
          [{ path: 'publicationId', issue: `reschedule_not_allowed_in_state:${row.state}` }],
          'This publication cannot be rescheduled in its current state',
        );
    }
    return toPublicationDto(await publicationsRepo.getById(row.id, tx));
  },

  async get(actor: ResolvedActor, input: z.infer<typeof PublicationGet>, tx?: Tx) {
    const parsed = PublicationGet.parse(input);
    const row = await publicationsRepo.getById(parsed.publicationId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    const attempts = await attemptsRepo.listForPublication(row.id, tx);
    return { ...toPublicationDto(row), attempts: attempts.map(toAttemptDto) };
  },

  async list(actor: ResolvedActor, input: z.infer<typeof PublicationList>, tx?: Tx) {
    const parsed = PublicationList.parse(input);
    await assertBrandExists(parsed.brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(parsed.brandId), {}, tx);
    const page = await publicationsRepo.listForBrand(parsed.brandId, parsed.state, parsed.page, tx);
    return { items: page.items.map(toPublicationDto), nextCursor: page.nextCursor };
  },

  async evidence(actor: ResolvedActor, input: z.infer<typeof PublicationEvidence>, tx?: Tx) {
    const parsed = PublicationEvidence.parse(input);
    const row = await publicationsRepo.getById(parsed.publicationId, tx);
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    return (await evidenceRepo.listForPublication(row.id, tx)).map(toEvidenceDto);
  },

  /**
   * Runbook "reconcile an outcome_unknown publication": the human resolution. confirm_published records
   * human_confirmation evidence (outcome_unknown → published); confirm_absent proves absence (→ retry_eligible);
   * cancel closes a held row. A row held after exhausted reconciliation keeps its state on confirmation: the
   * machine has no held → published move (reported as a gap); the evidence is recorded either way.
   */
  async reconcile(actor: ResolvedActor, input: z.infer<typeof ReconcileCommand>, tx: Tx) {
    const cmd = ReconcileCommand.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.schedule', publicationResource(row), {}, tx);
    if (row.state !== 'outcome_unknown' && row.state !== 'held')
      throw new ValidationFailedError(
        [{ path: 'publicationId', issue: `reconcile_not_allowed_in_state:${row.state}` }],
        'Only outcome_unknown or held publications can be reconciled by hand',
      );
    const attempts = await attemptsRepo.listForPublication(row.id, tx);
    const last = attempts.at(-1) ?? null;
    switch (cmd.resolution) {
      case 'confirm_published': {
        if (!cmd.remotePostId)
          throw new ValidationFailedError([
            { path: 'remotePostId', issue: 'required_for_confirm_published' },
          ]);
        const payload = {
          remotePostId: cmd.remotePostId,
          remoteUrl: cmd.remoteUrl ?? null,
          note: cmd.note ?? null,
          attemptId: last?.id ?? null,
        };
        await evidenceRepo.create(
          {
            id: newId('remoteEvidence'),
            publicationId: row.id,
            attemptId: last?.id ?? null,
            kind: 'human_confirmation',
            remotePostId: cmd.remotePostId,
            remoteUrl: cmd.remoteUrl ?? null,
            payload,
            payloadHash: hashCanonical(payload),
            capturedAt: new Date(),
          },
          tx,
        );
        if (last && !last.remotePostId) await attemptsRepo.attachRemotePost(last.id, cmd.remotePostId, tx);
        const toState =
          row.state === 'outcome_unknown'
            ? transition(row.state, 'reconcile_found', 'publicationId')
            : row.state;
        await publicationsRepo.update(
          row.id,
          row.version,
          {
            state: toState,
            remotePostId: cmd.remotePostId,
            remoteUrl: cmd.remoteUrl ?? null,
            stateReason: 'human_confirmed',
          },
          tx,
        );
        await recordStateChange(actor, 'publication.reconcile', row, toState, 'confirm_published', tx);
        break;
      }
      case 'confirm_absent': {
        const toState = transition(row.state, 'reconcile_absent', 'publicationId');
        await publicationsRepo.update(
          row.id,
          row.version,
          { state: toState, stateReason: 'human_confirmed_absent' },
          tx,
        );
        await recordStateChange(actor, 'publication.reconcile', row, toState, 'confirm_absent', tx);
        break;
      }
      case 'cancel': {
        const toState = transition(row.state, 'hold_resolved_cancel', 'publicationId');
        await publicationsRepo.update(
          row.id,
          row.version,
          { state: toState, stateReason: 'human_cancelled' },
          tx,
        );
        await recordStateChange(actor, 'publication.reconcile', row, toState, 'cancel', tx);
        break;
      }
    }
    return toPublicationDto(await publicationsRepo.getById(row.id, tx));
  },

  /**
   * Spec 13.5: deleting a live remote post is its own action (publication.delete_remote), never automatic. The
   * request is recorded and emitted; the adapter contract carries no delete call yet, so the event has no route.
   */
  async deleteRemote(actor: ResolvedActor, input: z.infer<typeof PublicationDeleteRemote>, tx: Tx) {
    const cmd = PublicationDeleteRemote.parse(input);
    const row = await publicationsRepo.lock(cmd.publicationId, tx);
    await policy.assert(actor, 'publication.delete_remote', publicationResource(row), {}, tx);
    if (row.state !== 'published' || !row.remotePostId)
      throw new ValidationFailedError(
        [{ path: 'publicationId', issue: 'not_published' }],
        'Only a published post with a remote id can be deleted remotely',
      );
    const connection = await connectionsRepo.getById(row.channelConnectionId, tx);
    const cap = registry().capability(connection.providerKey);
    if (!cap?.delete)
      throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: 'delete_not_supported' }]);
    await audit.record(
      actorRef(actor),
      'publication.delete_remote',
      { type: 'publication', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, publicationId: row.id, channelConnectionId: connection.id, reason: cmd.reason },
    );
    await outbox.add(
      'publication.delete_remote_requested',
      { type: 'publication', id: row.id, version: row.version },
      {
        publicationId: row.id,
        remotePostId: row.remotePostId,
        requestedByKind: actor.kind,
        requestedById: actor.id,
      },
      tx,
      { brandId: row.brandId },
    );
    return { accepted: true, publicationId: row.id, remotePostId: row.remotePostId };
  },

  /** Review module release checker (spec 13.4 mandate_daily_quota). */
  countForMandateOnDay: (mandateId: string, at: Date, tx?: Tx) =>
    publicationsRepo.countForMandateOnDay(mandateId, at, tx),

  /** Content module calendar source (spec 7.5 content.calendar.range): publications of a brand in a window. */
  async calendarRange(brandId: string, from: Date, to: Date, tx?: Tx) {
    const page = await publicationsRepo.listForBrand(brandId, undefined, { limit: 200 }, tx);
    return page.items
      .filter((p) => p.scheduledFor >= from && p.scheduledFor <= to)
      .map((p) => ({
        publicationId: p.id,
        contentPackageId: p.contentPackageId,
        contentRevisionId: p.contentRevisionId,
        channelVariantId: p.channelVariantId,
        channelConnectionId: p.channelConnectionId,
        scheduledFor: p.scheduledFor.toISOString(),
        state: p.state,
      }));
  },
};
