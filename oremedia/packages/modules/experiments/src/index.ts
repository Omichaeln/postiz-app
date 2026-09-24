// Experiments (spec 16.6): designed → pre-registered (frozen with a hash) → running → stopped → analysed, with
// hashed-visitor assignment for randomised link experiments and verdicts from the domain statistics.
export { experimentsService } from './service';
export { analyseExperiment, DIRECTIONAL_LABEL, type AnalysisOutcome } from './analysis';
export {
  registerExperimentListener,
  resetExperimentListeners,
  type ExperimentListener,
  type ExperimentMilestone,
} from './hooks';
export {
  ExperimentRepository,
  ExperimentVariantRepository,
  ExperimentAssignmentRepository,
  ExperimentResultRepository,
} from './repositories';
