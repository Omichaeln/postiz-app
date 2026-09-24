import { registerBrandChecker, MembershipRepository } from '@oremedia/module-access';
import { assetService, registerAssetOutboxRoutes } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { registerAssetAuthoriser, registerCreativeOutboxRoutes } from '@oremedia/module-creative';
import {
  registerAgentOutboxRoutes,
  registerWorkflowSignaller,
  type WorkflowSignaller,
} from '@oremedia/module-agents';
import { registerBrandChecker as registerSkillBrandChecker, skillsService } from '@oremedia/module-skills';
import { registerSkillResolver } from '@oremedia/ai';

/**
 * Wires cross-module hooks so modules never import each other's tables (same shape as apps/api/src/composition.ts),
 * plus the outbox routes that map events to workflow starts. Called by main and by tests.
 */
export function composeModules(opts: { signaller?: WorkflowSignaller } = {}): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  const memberships = new MembershipRepository();
  registerUsageCounters(async (_tenantId, tx) => ({
    brands: await brandService.count(tx),
    seats: await memberships.countActive(tx),
    channels: 0,
  }));
  registerAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(assetVersionId, ctx.purpose, { brandId: ctx.brandId }, tx);
  });
  registerAssetOutboxRoutes();
  registerCreativeOutboxRoutes();
  // Spec 12: agent runs start and are signalled through the outbox; the context resolver pins skills (spec 12.3).
  registerSkillBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerAgentOutboxRoutes();
  registerSkillResolver((input, tx) =>
    skillsService.resolveForRun(input.actor, { brandId: input.brandId, taskKind: input.taskKind }, tx),
  );
  registerWorkflowSignaller(opts.signaller ?? null);
}
