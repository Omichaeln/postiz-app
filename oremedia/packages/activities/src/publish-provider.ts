import type { PublishProviderActivitiesV1, PublishProviderRuntimeV1 } from '@oremedia/contracts/publishing';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Spec 14.3 provider activities (task queue `publish-<providerKey>`, one per provider so a slow platform cannot
 * starve others). publishOnce runs with maximumAttempts 1 in the workflow and never retries a mutation after
 * send; the heartbeat is handed to the runtime per activity (spec 20.3), which attaches it to ProviderIO. The
 * payload carries channelConnectionId-bearing references only: credentials are opened inside the runtime by the
 * broker and never enter Temporal (spec 14.7, R5).
 */
export function createPublishProviderActivities(
  runtime: PublishProviderRuntimeV1,
): PublishProviderActivitiesV1 {
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
    publishOnce: guarded((input) => {
      heartbeat(`publish:${input.attemptId}:start`);
      return runtime.publishOnce(input, { heartbeat });
    }),
    checkStatus: guarded((input) => runtime.checkStatus(input, { heartbeat })),
    finalize: guarded((input) => runtime.finalize(input, { heartbeat })),
    findRemotePost: guarded((input) => runtime.findRemotePost(input, { heartbeat })),
  };
}
