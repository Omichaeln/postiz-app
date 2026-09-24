import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { ElementCommentState, TemplateVersionState } from '@oremedia/contracts/creative';
import { ConflictError, NotFoundError } from '@oremedia/contracts/errors';
import { ID_LIST_MAX, type Page, type PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, affectedRows, requireTenant, type Tx } from '@oremedia/db';
import {
  creativeDocuments,
  creativeRevisions,
  elementComments,
  renderJobs,
  renderedExports,
  templateVersions,
  templates,
} from '@oremedia/db/schema/creative';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

export class CreativeDocumentRepository extends BrandScopedRepository<typeof creativeDocuments> {
  constructor() {
    super(creativeDocuments);
  }
  /**
   * Row lock (SELECT ... FOR UPDATE, as brands lock for version allocation): applyOperations serialises on the
   * document so two batches against the same head cannot both commit (spec 11.4). Same visibility rule as findById.
   */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(creativeDocuments)
      .where(this.scope(eq(creativeDocuments.id, id)))
      .for('update');
    const row = rows[0];
    const ctx = requireTenant();
    if (!row || (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)))
      throw new NotFoundError('CreativeDocument', id);
    return row;
  }
  async create(values: Omit<typeof creativeDocuments.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** Spec 11.4 documents.setCurrentRevision(doc.id, doc.version, revision.id): optimistic version → CONFLICT on mismatch. */
  async setCurrentRevision(id: string, expectedVersion: number, revisionId: string, tx: Tx) {
    await this.updateScoped(id, expectedVersion, { currentRevisionId: revisionId }, tx);
  }
}

/** Insert-only (spec 6.1): revisions are never updated or deleted; undo is a new revision. */
export class CreativeRevisionRepository extends BrandScopedRepository<typeof creativeRevisions> {
  constructor() {
    super(creativeRevisions);
  }
  async create(values: Omit<typeof creativeRevisions.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async list(
    brandId: string,
    documentId: string,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof creativeRevisions.$inferSelect>> {
    const clauses: SQL[] = [eq(creativeRevisions.documentId, documentId)];
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(creativeRevisions.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(creativeRevisions)
      .where(this.brandScope(brandId, and(...clauses) as SQL))
      .orderBy(desc(creativeRevisions.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}

export class RenderJobRepository extends BrandScopedRepository<typeof renderJobs> {
  constructor() {
    super(renderJobs);
  }
  async create(values: Omit<typeof renderJobs.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof renderJobs.$inferInsert>, tx: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
}

/** Insert-only (spec 6.1): an approved export is what gets published, byte for byte. */
export class RenderedExportRepository extends BrandScopedRepository<typeof renderedExports> {
  constructor() {
    super(renderedExports);
  }
  async create(values: Omit<typeof renderedExports.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /**
   * Every export of a revision, in id order. Export rows exist only once a job is `ready` (markReady inserts them),
   * so this is the revision's ready output; the content module picks channel variant exports from it (spec 14.1).
   */
  async listForRevision(brandId: string, revisionId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(renderedExports)
      .where(this.brandScope(brandId, eq(renderedExports.revisionId, revisionId)))
      .orderBy(asc(renderedExports.id))
      .limit(ID_LIST_MAX);
  }
  /** Exports by id (render_jobs.export_ids), in id order; bounded by the id-list maximum (spec 7.4). */
  async listByIds(brandId: string, ids: readonly string[], tx?: Tx) {
    if (ids.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(renderedExports)
      .where(this.brandScope(brandId, inArray(renderedExports.id, ids.slice(0, ID_LIST_MAX))))
      .orderBy(asc(renderedExports.id));
  }
}

export class ElementCommentRepository extends BrandScopedRepository<typeof elementComments> {
  constructor() {
    super(elementComments);
  }
  async create(values: Omit<typeof elementComments.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof elementComments.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    brandId: string,
    documentId: string,
    state: ElementCommentState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof elementComments.$inferSelect>> {
    const clauses: SQL[] = [eq(elementComments.documentId, documentId)];
    if (state) clauses.push(eq(elementComments.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(elementComments.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(elementComments)
      .where(this.brandScope(brandId, and(...clauses) as SQL))
      .orderBy(desc(elementComments.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /**
   * Spec 11.4 comments.markOutdatedFor: open comments anchored on a changed element become `outdated` (their
   * version moves with them). Returns the number of comments affected. Chunked to the id-list maximum.
   */
  async markOutdated(
    brandId: string,
    documentId: string,
    elementIds: readonly string[],
    tx: Tx,
  ): Promise<number> {
    let affected = 0;
    for (let i = 0; i < elementIds.length; i += ID_LIST_MAX) {
      const chunk = elementIds.slice(i, i + ID_LIST_MAX);
      const res = await this.conn(tx)
        .update(elementComments)
        .set({ state: 'outdated', version: sql`${elementComments.version} + 1` })
        .where(
          this.brandScope(
            brandId,
            and(
              eq(elementComments.documentId, documentId),
              eq(elementComments.state, 'open'),
              inArray(elementComments.elementId, chunk),
            ) as SQL,
          ),
        );
      affected += affectedRows(res);
    }
    return affected;
  }
}

export class TemplateRepository extends BrandScopedRepository<typeof templates> {
  constructor() {
    super(templates);
  }
  /** Parent-row lock: serialises version-number allocation and approval for one template. Same visibility as findById. */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(templates)
      .where(this.scope(eq(templates.id, id)))
      .for('update');
    const row = rows[0];
    const ctx = requireTenant();
    if (!row || (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)))
      throw new NotFoundError('Template', id);
    return row;
  }
  async create(values: Omit<typeof templates.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof templates.$inferInsert>, tx: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(brandId: string, page: PageRequest, tx?: Tx): Promise<Page<typeof templates.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(templates)
      .where(this.brandScope(brandId, cursor ? lte(templates.id, cursor.id) : undefined))
      .orderBy(desc(templates.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}

export class TemplateVersionRepository extends BrandScopedRepository<typeof templateVersions> {
  constructor() {
    super(templateVersions);
  }
  async create(values: Omit<typeof templateVersions.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** Next version number; callers hold the template row lock so two versions never race for the same number. */
  async nextNumber(brandId: string, templateId: string, tx: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${templateVersions.number}), 0)` })
      .from(templateVersions)
      .where(this.brandScope(brandId, eq(templateVersions.templateId, templateId)));
    return Number(rows[0]?.max ?? 0) + 1;
  }
  async listForTemplate(brandId: string, templateId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(templateVersions)
      .where(this.brandScope(brandId, eq(templateVersions.templateId, templateId)))
      .orderBy(desc(templateVersions.number));
  }
  /** Spec 8.3: ids of the brand's approved template versions (the snapshot's eligible templates), sorted. */
  async listApprovedIds(brandId: string, tx?: Tx): Promise<string[]> {
    const rows = await this.conn(tx)
      .select({ id: templateVersions.id })
      .from(templateVersions)
      .where(this.brandScope(brandId, eq(templateVersions.state, 'approved')))
      .orderBy(templateVersions.id);
    return rows.map((r) => r.id);
  }
  /**
   * Template versions carry no `version` column: state moves by compare-and-set on the current state, which is
   * the transition the caller computed through the machine. Zero rows means someone moved it first → CONFLICT.
   */
  async setState(
    id: string,
    brandId: string,
    fromState: TemplateVersionState,
    toState: TemplateVersionState,
    tx: Tx,
  ) {
    const res = await this.conn(tx)
      .update(templateVersions)
      .set({ state: toState })
      .where(
        this.brandScope(
          brandId,
          and(eq(templateVersions.id, id), eq(templateVersions.state, fromState)) as SQL,
        ),
      );
    if (affectedRows(res) !== 1) throw new ConflictError('TemplateVersion', id, 0);
  }
}
