import type {
  PublicationSweepActivitiesV1,
  PublicationSweepRuntimeV1,
  PublishControlActivitiesV1,
  PublishControlRuntimeV1,
} from '@oremedia/contracts/publishing';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { inTenant } from './tenant';

/**
 * Spec 14.3 control activities for publicationWorkflowV1 (task queue `core`): thin wrappers that establish tenant
 * context from the input (re-loading the scheduling actor's grants at the point of effect, spec 5.2) and translate
 * domain errors into the failure types the workflow's retry policy understands. Every effect lives in the
 * publishing module's runtime (createPublishingRuntime), and every control activity is idempotent there.
 */
export function createPublishControlActivities(runtime: PublishControlRuntimeV1): PublishControlActivitiesV1 {
  const guarded =
    <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, loadActorGrants, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    readSchedule: guarded((input) => runtime.readSchedule(input)),
    cancelIfNotStarted: guarded((input) => runtime.cancelIfNotStarted(input)),
    claimForDispatch: guarded((input) => runtime.claimForDispatch(input)),
    evaluateRelease: guarded((input) => runtime.evaluateRelease(input)),
    hold: guarded((input) => runtime.hold(input)),
    releaseClaimAndCancel: guarded((input) => runtime.releaseClaimAndCancel(input)),
    openAttempt: guarded((input) => runtime.openAttempt(input)),
    markProcessing: guarded((input) => runtime.markProcessing(input)),
    markPublished: guarded((input) => runtime.markPublished(input)),
    markFailed: guarded((input) => runtime.markFailed(input)),
    markOutcomeUnknown: guarded((input) => runtime.markOutcomeUnknown(input)),
    markRetryEligible: guarded((input) => runtime.markRetryEligible(input)),
    holdForHuman: guarded((input) => runtime.holdForHuman(input)),
    retryAfterProvenNoEffect: guarded((input) => runtime.retryAfterProvenNoEffect(input)),
  };
}

/** The sweeper is platform-level (no tenant input); the runtime declares the platform job itself (spec 5.3). */
export function createPublicationSweepActivities(
  runtime: PublicationSweepRuntimeV1,
): PublicationSweepActivitiesV1 {
  return {
    sweepPublications: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.sweepPublications(input)),
  };
}
