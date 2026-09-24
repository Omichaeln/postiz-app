import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { AuditQuery } from '@oremedia/contracts/operations';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { Decision } from '@oremedia/contracts/policy';
import { TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import { auditEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from './cursor';

export interface AuditActor {
  kind: string;
  id: string;
}

export interface AuditResource {
  type: string;
  id: string;
}

/** Allowlisted metadata keys (spec 6.2 audit_events.metadata: allowlisted fields only). */
const METADATA_ALLOWLIST = new Set([
  'fromState',
  'toState',
  'reason',
  'count',
  'brandId',
  'channelConnectionId',
  'publicationId',
  'revisionId',
  'runId',
  'toolName',
  'flag',
  'scope',
  'expectedVersion',
  'path',
  'ticketRef',
  'error', // a failure's truncated detail (never a payload or credential)
]);

class AuditRepository extends TenantScopedRepository<typeof auditEvents> {
  constructor() {
    super(auditEvents);
  }
  async append(values: Omit<typeof auditEvents.$inferInsert, 'tenantId'>, tx?: Tx): Promise<void> {
    await this.insertScoped(values, tx);
  }
  async query(
    q: z.infer<typeof AuditQuery>,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof auditEvents.$inferSelect>> {
    const clauses: SQL[] = [];
    if (q.resourceType) clauses.push(eq(auditEvents.resourceType, q.resourceType));
    if (q.resourceId) clauses.push(eq(auditEvents.resourceId, q.resourceId));
    if (q.actorId) clauses.push(eq(auditEvents.actorId, q.actorId));
    if (q.from) clauses.push(gte(auditEvents.createdAt, new Date(q.from)));
    if (q.to) clauses.push(lte(auditEvents.createdAt, new Date(q.to)));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(auditEvents.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(auditEvents)
      .where(this.scope(clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(auditEvents.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const next = rows.length > page.limit ? rows[page.limit] : undefined;
    return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
  }
}

const repo = new AuditRepository();

/** Every authorisation outcome and every state change is recorded in the command's transaction (spec 4.3). */
export const audit = {
  async record(
    actor: AuditActor,
    action: string,
    resource: AuditResource,
    decision: Decision | 'allowed' | 'denied',
    tx?: Tx,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const ctx = requireTenant();
    const id = newId('auditEvent');
    const d =
      typeof decision === 'string'
        ? { decision, reason: null }
        : {
            decision: decision.allowed ? ('allowed' as const) : ('denied' as const),
            reason: decision.reason,
          };
    const safeMeta = metadata
      ? Object.fromEntries(Object.entries(metadata).filter(([k]) => METADATA_ALLOWLIST.has(k)))
      : undefined;
    await repo.append(
      {
        id,
        actorKind: actor.kind,
        actorId: actor.id,
        supportSessionId: ctx.supportSessionId ?? null,
        action,
        resourceType: resource.type,
        resourceId: resource.id,
        decision: d.decision,
        reason: d.reason,
        correlationId: ctx.correlationId,
        metadata: safeMeta,
      },
      tx,
    );
    return id;
  },
  query: (q: z.infer<typeof AuditQuery>, page: PageRequest, tx?: Tx) => repo.query(q, page, tx),
};
