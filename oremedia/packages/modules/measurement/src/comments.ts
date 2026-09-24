import { createHmac } from 'node:crypto';
import type { ActivityHooks } from '@oremedia/contracts/agents';
import type {
  CommentIngestionRuntimeV1,
  PullCommentsInputV1,
  PullCommentsResultV1,
} from '@oremedia/contracts/measurement';
import { withTransaction } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { adapterFor, credentialBroker, providerIO } from '@oremedia/module-publishing';
import { collectionPlan, loadPublication } from './common';
import { authorHashSecretInUse, notifyCommentSinks, type IngestedComment } from './hooks';
import { ConversationRepository, MessageRepository } from './repositories';

/**
 * Spec 16.5 (first half, read-only) behind commentIngestionWorkflowV1 (task queue `ingest-comments`): comments of
 * a published post are pulled through the adapter's `fetchComments` surface into one conversation per remote post
 * and one message per remote comment. Author identities are per-tenant salted keyed hashes (the salt is derived
 * from a secret reference, never stored); raw ids never reach the hash. Classification, embedding and clustering
 * belong to the intelligence module, which subscribes through registerCommentSink.
 */
const conversationsRepo = new ConversationRepository();
const messagesRepo = new MessageRepository();

/** salt = HMAC(secret, tenant); hash = HMAC(salt, handle). Rotating the secret changes every hash. */
export function authorHash(secret: string, tenantId: string, authorHandle: string): string {
  const salt = createHmac('sha256', secret).update(`tenant:${tenantId}`).digest();
  return createHmac('sha256', salt).update(authorHandle.normalize('NFC').trim().toLowerCase()).digest('hex');
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
        const since = input.since
          ? new Date(input.since)
          : ((await messagesRepo.latestRemoteCreatedAt(conversation.id, tx)) ?? undefined);
        hooks?.heartbeat(`comments:${publicationId}:${input.pullIndex}`);
        const page = await credentialBroker.withCredentials(
          tenantId,
          connection.id,
          (creds) =>
            fetchComments(
              {
                remotePostId,
                ...(since ? { since } : {}),
                ...(input.cursor ? { cursor: input.cursor } : {}),
              },
              creds,
              providerIO(adapter.key, tenantId, hooks),
            ),
          tx,
        );
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
              classification: null,
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
