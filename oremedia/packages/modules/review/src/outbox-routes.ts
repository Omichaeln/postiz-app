import { BrandChangeImpactInputV1 } from '@oremedia/contracts/brand-change-impact';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: worker-core hosts task queue `core` (authority-bearing work; the publishing module names it too). */
const CORE_TASK_QUEUE = 'core';
export const BRAND_CHANGE_IMPACT_WORKFLOW_TYPE = 'brandChangeImpactWorkflowV1';

/**
 * Spec 8.2 / 13.2: brand.version_published and brand.fact_revoked → brandChangeImpactWorkflowV1 (invalidate the
 * brand's approvals, re-evaluate and hold or flag its scheduled publications). The workflow id is stable per
 * outbox event so a redelivered event joins the running workflow; the outbox row is the dedupe authority
 * (spec 14.2). The actor is the one who published or revoked, carried for tenant re-establishment (spec 5.2).
 */
export function registerReviewOutboxRoutes(): void {
  registerOutboxRoute('brand.version_published', (evt) => {
    const p = evt.payload;
    const input = BrandChangeImpactInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      brandId: p['brandId'],
      change: { kind: 'version_published', brandVersionId: p['brandVersionId'] },
    });
    return {
      workflowType: BRAND_CHANGE_IMPACT_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: `brand-change:${evt.id}`,
      args: [input],
    };
  });
  registerOutboxRoute('brand.fact_revoked', (evt) => {
    const p = evt.payload;
    const input = BrandChangeImpactInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      brandId: p['brandId'],
      change: { kind: 'fact_revoked', factId: p['factId'] },
    });
    return {
      workflowType: BRAND_CHANGE_IMPACT_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: `brand-change:${evt.id}`,
      args: [input],
    };
  });
}
