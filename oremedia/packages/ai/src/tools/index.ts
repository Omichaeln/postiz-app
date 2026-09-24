import { ToolRegistry, type AnyToolDefinition } from '../tool-registry';
import { assetsSearchEligible } from './assets';
import { brandGetSnapshot, factsList } from './brand';
import { contentCreateBrief, contentDraftCopy } from './content';
import { creativeProposeOperations, creativeRequestRender } from './creative';
import { imagesGenerate } from './images';
import { experimentsProposeDesign, metricsQuery, recommendationsCreate, voiceClusters } from './intelligence';
import { publicationsProposeSchedule } from './publications';
import { reviewRequest, reviewRunBrandReview } from './review';

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
export { reviewRunBrandReview, reviewRequest } from './review';
export { contentCreateBrief, contentDraftCopy } from './content';
export { publicationsProposeSchedule, ScheduleProposalPayload } from './publications';
export { metricsQuery, voiceClusters, recommendationsCreate, experimentsProposeDesign } from './intelligence';
export {
  NOT_AVAILABLE_YET,
  defaultToolServices,
  imageGeneratorFromEnv,
  registerImageGenerator,
  registerIntelligenceToolSource,
  registerContentToolSource,
  registerReviewToolSource,
  registerPublishingToolSource,
  type ImageGenerator,
  type IntelligenceToolSource,
  type ContentToolSource,
  type ReviewToolSource,
  type PublishingToolSource,
  type ToolRunRef,
  type ToolServices,
} from './services';
