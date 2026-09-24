import type { ExperimentVerdict } from '@oremedia/contracts/experiments';
import type { Tx } from '@oremedia/db';

/**
 * Cross-module hooks (same pattern as the publishing module's hooks.ts: modules never import each other's
 * tables). The intelligence module listens for experiment milestones to write the learning record
 * (spec 16.8: executed revision → observed outcome → verdict); until it registers nothing listens.
 */
export interface ExperimentMilestone {
  kind: 'pre_registered' | 'started' | 'stopped' | 'analysed';
  tenantId: string;
  brandId: string;
  experimentId: string;
  recommendationId: string | null;
  preRegistrationHash: string | null;
  mode: 'randomised' | 'structured_comparison';
  /** started only: the treatment revision that goes live (the learning record's executed revision). */
  executedRevisionId?: string | null;
  /** analysed only */
  resultId?: string;
  verdict?: ExperimentVerdict;
  verdictReason?: string;
}
export type ExperimentListener = (milestone: ExperimentMilestone, tx: Tx) => Promise<void>;
const listeners: ExperimentListener[] = [];
export const registerExperimentListener = (fn: ExperimentListener): void => {
  listeners.push(fn);
};
export const resetExperimentListeners = (): void => {
  listeners.length = 0;
};
export async function notifyExperiment(milestone: ExperimentMilestone, tx: Tx): Promise<void> {
  for (const listener of listeners) await listener(milestone, tx);
}

/**
 * Spec 16.6 randomised link experiments: the measurement module owns tracked links and clicks, so the composition
 * root registers how an experiment's arm links are created at start and how exposures per variant are read back
 * from the redirector's clicks. Not composed (a process without link tracking), experiments run without links.
 */
export interface ExperimentArmLinks {
  /** Per-arm tracked links (to the first URL of each arm's text) and the entry link; null when not possible. */
  create(
    input: { brandId: string; experimentId: string; arms: Array<{ variantId: string; text: string }> },
    tx: Tx,
  ): Promise<{ entryShortCode: string; shortUrl: string | null } | null>;
  /** Distinct visitors recorded on each arm's link, by experiment variant id. */
  exposures(brandId: string, experimentId: string, tx: Tx): Promise<Map<string, number>>;
}
let armLinks: ExperimentArmLinks | null = null;
export const registerExperimentArmLinks = (links: ExperimentArmLinks | null): void => {
  armLinks = links;
};
export const experimentArmLinks = (): ExperimentArmLinks | null => armLinks;
