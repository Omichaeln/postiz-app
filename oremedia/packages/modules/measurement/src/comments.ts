import type { ActivityHooks } from '@oremedia/contracts/agents';
import type {
  CommentIngestionRuntimeV1,
  PullCommentsInputV1,
  PullCommentsResultV1,
} from '@oremedia/contracts/measurement';
import { withTransaction } from '@oremedia/db';
import { tenantKeyedHash } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { adapterFor, credentialBroker, providerIO } from '@oremedia/module-publishing';
import { collectionPlan, loadPublication } from './common';
import { authorHashSecretInUse, classifyComment, notifyCommentSinks, type IngestedComment } from './hooks';
import { ConversationRepository, MessageRepository } from './repositories';

/**
 * Spec 16.5 (first half, read-only) behind commentIngestionWorkflowV1 (task queue `ingest-comments`): comments of
 * a published post are pulled through the adapter's `fetchComments` surface into one conversation per remote post
 * and one message per remote comment. Author identities are per-tenant salted keyed hashes (the salt is derived
 * from a secret reference, never stored); raw ids never reach the hash. Classification (a model call, made before
 * the transaction through registerCommentClassifier), embedding and clustering belong to the intelligence module,
 * which subscribes through registerCommentSink.
 */
const conversationsRepo = new ConversationRepository();
const messagesRepo = new MessageRepository();

/** salt = HMAC(secret, tenant); hash = HMAC(salt, handle). Rotating the secret changes every hash. */
export function authorHash(secret: string, tenantId: string, authorHandle: string): string {
  return tenantKeyedHash(secret, tenantId, authorHandle.normalize('NFC').trim().toLowerCase());
}

export function createCommentIngestionRuntime(): CommentIngestionRuntimeV1 {
  return {
    readCollectionPlan: ({ publicationId }) => collectionPlan(publicationId),

    async pullComments(input: PullCommentsInputV1, hooks?: ActivityHooks): Promise<PullCommentsResultV1> {
      const { tenantId, publicationId } = input;
      const { row, connection } = await loadPublication(publicationId);
      const adapter = adapterFor(connection.providerKey);
      const fetchComments = adapter.fetchComments?.bind(adapter);
      if (!fetchComments || !adapter.capability.comments.read || !row.remotePostId)
        return { ingested: 0, duplicates: 0, nextCursor: null };
      const remotePostId = row.remotePostId;
      const secret = authorHashSecretInUse();

      // Network and model calls run before the transaction opens (as pullMetrics does): the conversation and its
      // newest message are read first, the page is fetched, new comments are classified, and only then are rows
      // written. The transaction re-checks each comment, so a concurrent or repeated pull still writes it once.
      const known = await conversationsRepo.findByRemoteThread(connection.id, remotePostId);
      const since = input.since
        ? new Date(input.since)
        : known
          ? ((await messagesRepo.latestRemoteCreatedAt(known.id)) ?? undefined)
          : undefined;
      hooks?.heartbeat(`comments:${publicationId}:${input.pullIndex}`);
      const page = await credentialBroker.withCredentials(tenantId, connection.id, (creds) =>
        fetchComments(
          {
            remotePostId,
            ...(since ? { since } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          creds,
          providerIO(adapter.key, tenantId, hooks),
        ),
      );
      // A retried pull does not pay for a model call on a comment it already stored.
      const classifications = new Map<string, IngestedComment['classification']>();
      for (const item of page.items) {
        if (known && (await messagesRepo.existsRemote(known.id, item.remoteCommentId))) continue;
        classifications.set(
          item.remoteCommentId,
          await classifyComment({ brandId: row.brandId, text: item.text }),
        );
      }

      return withTransaction(async (tx) => {
        let conversation = await conversationsRepo.findByRemoteThread(connection.id, remotePostId, tx);
        if (!conversation) {
          const id = newId('conversation');
          await conversationsRepo.create(
            {
              id,
              brandId: row.brandId,
              channelConnectionId: connection.id,
              publicationId: row.id,
              remoteThreadId: remotePostId,
              state: 'open',
              assignedToUserId: null,
              lastMessageAt: null,
            },
            tx,
          );
          conversation = await conversationsRepo.getById(id, tx);
        }
        const ingested: IngestedComment[] = [];
        let duplicates = 0;
        let latest = conversation.lastMessageAt;
        for (const item of page.items) {
          if (await messagesRepo.existsRemote(conversation.id, item.remoteCommentId, tx)) {
            duplicates += 1;
            continue;
          }
          const id = newId('message');
          const remoteCreatedAt = new Date(item.createdAt);
          const hash = authorHash(secret, tenantId, item.authorHandle);
          const classification = classifications.get(item.remoteCommentId) ?? null;
          await messagesRepo.create(
            {
              id,
              brandId: row.brandId,
              conversationId: conversation.id,
              remoteMessageId: item.remoteCommentId,
              direction: 'inbound',
              authorHash: hash,
              authorHandle: item.authorHandle.slice(0, 200),
              text: item.text,
              sentiment: null,
              classification,
              substantive: null,
              clusterId: null,
              remoteCreatedAt,
            },
            tx,
          );
          if (!latest || remoteCreatedAt > latest) latest = remoteCreatedAt;
          ingested.push({
            messageId: id,
            conversationId: conversation.id,
            brandId: row.brandId,
            publicationId: row.id,
            channelConnectionId: connection.id,
            authorHash: hash,
            text: item.text,
            remoteCreatedAt: remoteCreatedAt.toISOString(),
            classification,
          });
        }
        if (ingested.length && latest && latest.getTime() !== conversation.lastMessageAt?.getTime())
          await conversationsRepo.update(
            conversation.id,
            conversation.version,
            { lastMessageAt: latest },
            tx,
          );
        await notifyCommentSinks(ingested, tx);
        return { ingested: ingested.length, duplicates, nextCursor: page.nextCursor ?? null };
      });
    },
  };
}
