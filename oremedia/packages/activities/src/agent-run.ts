import { ApplicationFailure } from '@temporalio/common';
import type { AgentRunActivitiesV1, AgentRunRuntimeV1 } from '@oremedia/contracts/agents';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { OremediaError } from '@oremedia/contracts/errors';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Spec 12.2 failure contract: domain errors that no retry can fix become ApplicationFailure.nonRetryable with one
 * of the three `type`s the workflow maps to terminal states. nonRetryableErrorTypes matches this type, not a class
 * name. Anything else (a lost connection, a provider outage) propagates and is retried by Temporal.
 */
export function toActivityFailure(err: unknown): unknown {
  if (err instanceof ApplicationFailure) return err;
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'IllegalTransitionError')
    return ApplicationFailure.nonRetryable((err as Error).message, 'ValidationFailed');
  if (!(err instanceof OremediaError)) return err;
  switch (err.code) {
    case 'FORBIDDEN':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'TENANT_CONTEXT_MISSING':
      return ApplicationFailure.nonRetryable(err.message, 'PolicyDenied');
    case 'BUDGET_EXHAUSTED':
    case 'ENTITLEMENT_EXCEEDED':
      return ApplicationFailure.nonRetryable(err.message, 'BudgetExhausted');
    case 'VALIDATION_FAILED':
    case 'STALE_REVISION':
    case 'RIGHTS_INELIGIBLE':
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_INVALID':
      return ApplicationFailure.nonRetryable(err.message, 'ValidationFailed');
    default:
      return err;
  }
}

/**
 * Spec 12.2 activities for agentRunWorkflowV1: thin wrappers that establish tenant context (re-loading the run's
 * service-principal grants at the point of effect, spec 5.2), heartbeat around the model call and translate domain
 * errors into the workflow's failure types. The runtime (apps/worker-core wires @oremedia/module-agents'
 * createAgentRunRuntime) holds every effect.
 */
export function createAgentRunActivities(runtime: AgentRunRuntimeV1): AgentRunActivitiesV1 {
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
    resolveContextSnapshot: guarded((input) => runtime.resolveContextSnapshot(input)),
    reserveBudget: guarded((input) => runtime.reserveBudget(input)),
    planNextStep: guarded((input) => {
      heartbeat(`plan:${input.step}`);
      return runtime.planNextStep(input, { heartbeat });
    }),
    dispatchTool: guarded((input) => runtime.dispatchTool(input)),
    recordDecision: guarded((input) => runtime.recordDecision(input)),
    finishRun: guarded((input) => runtime.finishRun(input)),
    settleBudget: guarded((input) => runtime.settleBudget(input)),
  };
}
