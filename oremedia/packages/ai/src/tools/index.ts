import { ToolRegistry, type AnyToolDefinition } from '../tool-registry';
import { assetsSearchEligible } from './assets';
import { brandGetSnapshot, factsList } from './brand';
import { creativeProposeOperations, creativeRequestRender } from './creative';
import { imagesGenerate } from './images';
import {
  contentCreateBrief,
  contentDraftCopy,
  experimentsProposeDesign,
  metricsQuery,
  publicationsProposeSchedule,
  recommendationsCreate,
  reviewRequest,
  voiceClusters,
} from './not-available-yet';
import { reviewRunBrandReview } from './review';

/** Spec 12.4 Release 1 tool registry, in the order of the table. No tool has an external effect. */
export const RELEASE_1_TOOLS: readonly AnyToolDefinition[] = [
  brandGetSnapshot,
  assetsSearchEligible,
  factsList,
  metricsQuery,
  voiceClusters,
  contentCreateBrief,
  contentDraftCopy,
  creativeProposeOperations,
  creativeRequestRender,
  imagesGenerate,
  reviewRunBrandReview,
  reviewRequest,
  experimentsProposeDesign,
  recommendationsCreate,
  publicationsProposeSchedule,
];

export function createReleaseOneRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of RELEASE_1_TOOLS) registry.register(def);
  return registry;
}

export {
  brandGetSnapshot,
  factsList,
  assetsSearchEligible,
  creativeProposeOperations,
  creativeRequestRender,
};
export { applyProposalBatch, CreativeProposalPayload } from './creative';
export { imagesGenerate, IMAGE_COST_MICROS } from './images';
export { reviewRunBrandReview } from './review';
export { NOT_AVAILABLE_YET } from './not-available-yet';
export {
  defaultToolServices,
  imageGeneratorFromEnv,
  registerImageGenerator,
  type ImageGenerator,
  type ToolServices,
} from './services';
