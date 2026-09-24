import { registerBrandChecker, MembershipRepository } from '@oremedia/module-access';
import { assetService } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { registerAssetAuthoriser } from '@oremedia/module-creative';
import {
  registerBrandChecker as registerSkillBrandChecker,
  registerEvaluationRunner,
  skillsService,
} from '@oremedia/module-skills';
import { createEvaluationRunnerFromEnv, createReleaseOneRegistry, registerSkillResolver } from '@oremedia/ai';

/** Wires cross-module hooks so modules never import each other's tables. Called by main and by tests. */
export function composeModules(): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  // Skills validate brand ids the same way (spec 4.2: the skills module never reads the brand tables).
  registerSkillBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  const memberships = new MembershipRepository();
  registerUsageCounters(async (_tenantId, tx) => ({
    brands: await brandService.count(tx),
    seats: await memberships.countActive(tx),
    channels: 0,
  }));
  // Spec 11.4 guardAssets: every asset version an operation introduces is authorised for its purpose.
  registerAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(assetVersionId, ctx.purpose, { brandId: ctx.brandId }, tx);
  });
  // Spec 12.3: the context resolver pins skill versions through the skills module; spec 19.6: the agent runtime
  // grades evaluation suites (adapters come from the environment on first use).
  registerSkillResolver((input, tx) =>
    skillsService.resolveForRun(input.actor, { brandId: input.brandId, taskKind: input.taskKind }, tx),
  );
  registerEvaluationRunner(createEvaluationRunnerFromEnv(createReleaseOneRegistry()));
}
