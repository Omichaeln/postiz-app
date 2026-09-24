import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, TenantScopedRepository, type Tx } from '@oremedia/db';
import { agentRuns, agentSteps, toolInvocations } from '@oremedia/db/schema/agents';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

export class AgentRunRepository extends BrandScopedRepository<typeof agentRuns> {
  constructor() {
    super(agentRuns);
  }
  async create(values: Omit<typeof agentRuns.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof agentRuns.$inferInsert>, tx?: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** SELECT ... FOR UPDATE: state moves under the row lock so a signal and an activity cannot interleave. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(agentRuns)
      .where(this.scope(eq(agentRuns.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('AgentRun', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async listForBrand(
    brandId: string,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof agentRuns.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(agentRuns)
      .where(this.brandScope(brandId, cursor ? sql`${agentRuns.id} <= ${cursor.id}` : undefined))
      .orderBy(desc(agentRuns.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const next = rows.length > page.limit ? rows[page.limit] : undefined;
    return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
  }
}

/** Insert-only (spec 6.1): no update or delete methods exist. */
export class AgentStepRepository extends TenantScopedRepository<typeof agentSteps> {
  constructor() {
    super(agentSteps);
  }
  async append(values: Omit<typeof agentSteps.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async nextIndex(runId: string, tx?: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${agentSteps.index}), -1)` })
      .from(agentSteps)
      .where(this.scope(eq(agentSteps.runId, runId)));
    return Number(rows[0]?.max ?? -1) + 1;
  }
  async listForRun(runId: string, page: PageRequest, tx?: Tx): Promise<Page<typeof agentSteps.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(agentSteps)
      .where(
        this.scope(
          cursor
            ? and(eq(agentSteps.runId, runId), gte(agentSteps.id, cursor.id))
            : eq(agentSteps.runId, runId),
        ),
      )
      .orderBy(asc(agentSteps.index))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const next = rows.length > page.limit ? rows[page.limit] : undefined;
    return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
  }
  async allForRun(runId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(agentSteps)
      .where(this.scope(eq(agentSteps.runId, runId)))
      .orderBy(asc(agentSteps.index));
  }
  async totals(runId: string, tx?: Tx): Promise<{ modelCalls: number; tokens: number; costMicros: number }> {
    const rows = await this.conn(tx)
      .select({
        modelCalls: sql<number>`coalesce(sum(case when ${agentSteps.kind} = 'model_call' then 1 else 0 end), 0)`,
        tokens: sql<number>`coalesce(sum(${agentSteps.tokensIn} + ${agentSteps.tokensOut}), 0)`,
        costMicros: sql<number>`coalesce(sum(${agentSteps.costMicros}), 0)`,
      })
      .from(agentSteps)
      .where(this.scope(eq(agentSteps.runId, runId)));
    const r = rows[0];
    return {
      modelCalls: Number(r?.modelCalls ?? 0),
      tokens: Number(r?.tokens ?? 0),
      costMicros: Number(r?.costMicros ?? 0),
    };
  }
}

/** Insert-only (spec 6.1): no update or delete methods exist. */
export class ToolInvocationRepository extends TenantScopedRepository<typeof toolInvocations> {
  constructor() {
    super(toolInvocations);
  }
  async append(values: Omit<typeof toolInvocations.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async listForRun(runId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(toolInvocations)
      .where(this.scope(eq(toolInvocations.runId, runId)))
      .orderBy(asc(toolInvocations.id));
  }
  async listForSteps(runId: string, stepIds: readonly string[], tx?: Tx) {
    if (stepIds.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(toolInvocations)
      .where(this.scope(and(eq(toolInvocations.runId, runId), inArray(toolInvocations.stepId, [...stepIds]))))
      .orderBy(asc(toolInvocations.id));
  }
  /** The proposal a step produced (outcome proposal); at most one per step. */
  async findProposal(runId: string, stepId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(toolInvocations)
      .where(
        this.scope(
          and(
            eq(toolInvocations.runId, runId),
            eq(toolInvocations.stepId, stepId),
            eq(toolInvocations.outcome, 'proposal'),
          ),
        ),
      )
      .orderBy(desc(toolInvocations.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
