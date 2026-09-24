import { ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { PublicationForRelease } from '@oremedia/contracts/publishing';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import { publicationMachine, type PublicationEvent } from '@oremedia/domain/state-machines/publication';
import type { PublicationState } from '@oremedia/contracts/publishing';
import { missingScopes } from '@oremedia/providers';
import { registry } from './providers';
import type {
  ChannelConnectionRepository,
  PublicationAttemptRepository,
  PublicationRepository,
  RemoteEvidenceRepository,
} from './repositories';

export type ConnectionRow = Awaited<ReturnType<ChannelConnectionRepository['getById']>>;
export type PublicationRow = Awaited<ReturnType<PublicationRepository['getById']>>;
export type AttemptRow = Awaited<ReturnType<PublicationAttemptRepository['getById']>>;
export type EvidenceRow = Awaited<ReturnType<RemoteEvidenceRepository['getById']>>;

export const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
export function transition(from: PublicationState, event: PublicationEvent, path: string): PublicationState {
  try {
    return publicationMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/**
 * Spec 14.2: a stable workflow id per publication, `pub:<publicationId>`. The starter's reuse policy
 * (ALLOW_DUPLICATE_FAILED_ONLY) never restarts a completed run, so a re-release after a hold or a proven absence
 * (held/retry_eligible → scheduled) starts a new generation suffixed with the row version it was released at.
 * The id in force is stored on the row (`claimant`, `<workflowId>` while scheduled, `<workflowId>:<runId>` once
 * claimed) so cancel and reschedule signals reach the right execution.
 */
export const publicationWorkflowId = (publicationId: string, generation: number): string =>
  generation === 0 ? `pub:${publicationId}` : `pub:${publicationId}:r${generation}`;
export const reconcileWorkflowId = (publicationId: string, version: number): string =>
  `pub:${publicationId}:reconcile:${version}`;
const RUN_ID_SUFFIX = /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const workflowIdOf = (row: Pick<PublicationRow, 'id' | 'claimant'>): string =>
  row.claimant ? row.claimant.replace(RUN_ID_SUFFIX, '') : publicationWorkflowId(row.id, 0);

/** Spec 13.4 channel_active: active, not reconnect_needed, granted scopes cover the capability's requiredScopes. */
export function connectionUsable(row: ConnectionRow): boolean {
  if (row.status !== 'active') return false;
  const cap = registry().capability(row.providerKey);
  if (!cap || !cap.certifiedAt) return false;
  return missingScopes(cap.requiredScopes, row.grantedScopes).length === 0;
}

/** Never the credential reference: a connection DTO carries state and scopes only. */
export const toConnectionDto = (c: ConnectionRow) => ({
  id: c.id,
  brandId: c.brandId,
  providerKey: c.providerKey,
  remoteAccountId: c.remoteAccountId,
  displayName: c.displayName,
  grantedScopes: c.grantedScopes,
  missingScopes: c.missingScopes,
  status: c.status,
  tokenExpiresAt: c.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : null,
  capabilityVersion: c.capabilityVersion,
  usable: connectionUsable(c),
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
  version: c.version,
});

export const toPublicationDto = (p: PublicationRow) => ({
  id: p.id,
  brandId: p.brandId,
  contentPackageId: p.contentPackageId,
  contentRevisionId: p.contentRevisionId,
  channelVariantId: p.channelVariantId,
  channelConnectionId: p.channelConnectionId,
  occurrenceKey: p.occurrenceKey,
  authority: p.authority,
  approvalId: p.approvalId,
  mandateId: p.mandateId,
  scheduledFor: p.scheduledFor.toISOString(),
  state: p.state,
  stateReason: p.stateReason,
  holdReasons: p.holdReasons ?? [],
  remotePostId: p.remotePostId,
  remoteUrl: p.remoteUrl,
  fencingToken: p.fencingToken,
  claimedAt: p.claimedAt ? p.claimedAt.toISOString() : null,
  scheduledByKind: p.scheduledByKind,
  scheduledById: p.scheduledById,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  version: p.version,
});

export const toAttemptDto = (a: AttemptRow) => ({
  id: a.id,
  publicationId: a.publicationId,
  attemptNumber: a.attemptNumber,
  fencingToken: a.fencingToken,
  requestFingerprint: a.requestFingerprint,
  providerIdempotencyKey: a.providerIdempotencyKey,
  startedAt: a.startedAt.toISOString(),
  sentAt: a.sentAt ? a.sentAt.toISOString() : null,
  finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
  /** The recorded outcome; `unknown` with no finishedAt means the attempt is still open. */
  outcome: a.finishedAt ? a.outcome : null,
  errorCode: a.errorCode,
  errorDetail: a.errorDetail,
  remoteJobId: a.remoteJobId,
  remotePostId: a.remotePostId,
});

export const toEvidenceDto = (e: EvidenceRow) => ({
  id: e.id,
  publicationId: e.publicationId,
  attemptId: e.attemptId,
  kind: e.kind,
  remotePostId: e.remotePostId,
  remoteUrl: e.remoteUrl,
  payload: e.payload,
  payloadHash: e.payloadHash,
  capturedAt: e.capturedAt.toISOString(),
});

/** The publication as the release evaluator sees it (spec 13.4): references only, from the live row. */
export const forRelease = (p: PublicationRow): PublicationForRelease => ({
  id: p.id,
  tenantId: p.tenantId,
  brandId: p.brandId,
  contentPackageId: p.contentPackageId,
  contentRevisionId: p.contentRevisionId,
  channelVariantId: p.channelVariantId,
  channelConnectionId: p.channelConnectionId,
  authority: p.authority,
  approvalId: p.approvalId,
  mandateId: p.mandateId,
  scheduledFor: p.scheduledFor.toISOString(),
  state: p.state,
});
