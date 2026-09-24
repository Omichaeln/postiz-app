import type {
  CommentIngestionActivitiesV1,
  CommentIngestionRuntimeV1,
} from '@oremedia/contracts/measurement';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/** Spec 16.5 commentIngestionWorkflowV1 activities (task queue `ingest-comments`, worker-ingest); see metric-collection.ts. */
export function createCommentIngestionActivities(
  runtime: CommentIngestionRuntimeV1,
): CommentIngestionActivitiesV1 {
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
    readCollectionPlan: guarded((input) => runtime.readCollectionPlan(input)),
    pullComments: guarded((input) => {
      heartbeat(`comments:${input.publicationId}:${input.pullIndex}:start`);
      return runtime.pullComments(input, { heartbeat });
    }),
  };
}
