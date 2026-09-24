import type { TokenRefreshActivitiesV1, TokenRefreshRuntimeV1 } from '@oremedia/contracts/publishing';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { inTenant } from './tenant';

/**
 * Spec 14.7 tokenRefreshWorkflowV1 activities (task queue `core`): tenant context from the input, the connecting
 * actor's grants re-loaded at the point of effect; the refresh itself (per-connection lock, new credential row,
 * refresh_needed / reconnect_needed on failure) lives in the publishing runtime.
 */
export function createTokenRefreshActivities(runtime: TokenRefreshRuntimeV1): TokenRefreshActivitiesV1 {
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
    readRefreshSchedule: guarded((input) => runtime.readRefreshSchedule(input)),
    refreshCredentials: guarded((input) => runtime.refreshCredentials(input)),
  };
}
