/** worker-core (spec 4.4): outbox dispatch now; core/agents/publish-{provider} Temporal workers arrive with Phases 4 and 5. */
export { composeModules } from './composition';
export {
  TemporalWorkflowStarter,
  connectTemporal,
  temporalConfigFromEnv,
  type TemporalConfig,
} from './temporal';
export { runDispatchLoop, type DispatchLoopOptions } from './dispatch-loop';
