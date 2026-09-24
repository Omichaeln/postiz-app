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
