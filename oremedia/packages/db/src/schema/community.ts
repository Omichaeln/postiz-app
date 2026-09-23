import {
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { brandId, createdAt, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const conversations = mysqlTable(
  'conversations',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    channelConnectionId: ref('channel_connection_id').notNull(),
    publicationId: ref('publication_id'),
    remoteThreadId: varchar('remote_thread_id', { length: 200 }).notNull(),
    state: mysqlEnum('state', ['open', 'assigned', 'resolved', 'escalated', 'archived'])
      .notNull()
      .default('open'),
    assignedToUserId: ref('assigned_to_user_id'),
    lastMessageAt: ts('last_message_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_conversation_remote').on(t.tenantId, t.channelConnectionId, t.remoteThreadId),
    uniqueIndex('uq_conversation_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_conversation_brand',
    }),
  ],
);

export const messages = mysqlTable(
  'messages',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    conversationId: ref('conversation_id').notNull(),
    remoteMessageId: varchar('remote_message_id', { length: 200 }).notNull(),
    direction: mysqlEnum('direction', ['inbound', 'outbound']).notNull(),
    authorHash: varchar('author_hash', { length: 64 }).notNull(), // per-tenant salted
    authorHandle: varchar('author_handle', { length: 200 }), // shown only with inbox.respond
    text: text('text').notNull(),
    sentiment: mysqlEnum('sentiment', ['positive', 'neutral', 'negative']),
    classification: mysqlEnum('classification', [
      'question',
      'objection',
      'praise',
      'need',
      'complaint',
      'spam',
      'other',
    ]),
    substantive: mysqlEnum('substantive', ['yes', 'no']),
    clusterId: ref('cluster_id'),
    remoteCreatedAt: ts('remote_created_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_message_remote').on(t.tenantId, t.conversationId, t.remoteMessageId),
    index('ix_message_brand_time').on(t.tenantId, t.brandId, t.remoteCreatedAt),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.brandId, conversations.id],
      name: 'fk_message_conversation',
    }),
  ],
);

export const communityAssignments = mysqlTable(
  'community_assignments',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    conversationId: ref('conversation_id').notNull(),
    assignedToUserId: ref('assigned_to_user_id').notNull(),
    assignedByKind: mysqlEnum('assigned_by_kind', ['user', 'recommendation', 'rule']).notNull(),
    assignedById: ref('assigned_by_id').notNull(),
    dueAt: ts('due_at'),
    state: mysqlEnum('state', ['open', 'done', 'reassigned']).notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('ix_assignment_user').on(t.tenantId, t.assignedToUserId, t.state)],
);

export const responseDrafts = mysqlTable(
  'response_drafts',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    conversationId: ref('conversation_id').notNull(),
    authorKind: mysqlEnum('author_kind', ['user', 'agent']).notNull(),
    authorId: ref('author_id').notNull(),
    text: text('text').notNull(),
    factRefs: json('fact_refs').$type<string[]>().notNull(),
    state: mysqlEnum('state', ['draft', 'sent', 'discarded']).notNull().default('draft'),
    sentByUserId: ref('sent_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('ix_response_draft_conversation').on(t.tenantId, t.conversationId, t.state)],
);
