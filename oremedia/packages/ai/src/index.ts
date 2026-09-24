// Agent runtime building blocks (spec 12): model adapters, routing policy, context resolver, prompt assembly,
// the tool registry and dispatcher, the Release 1 tools and the evaluation harness. Durable run state and the
// Temporal workflow live in @oremedia/module-agents, @oremedia/workflows and @oremedia/activities.
export { type ModelAdapter, type ModelConfig, modelConfigFromEnv, estimateCostMicros } from './model-adapter';
export { createModelAdapterFromEnv } from './adapter-factory';
export {
  AnthropicModelAdapter,
  anthropicApiKeyFromEnv,
  createAnthropicAdapterFromEnv,
  toCompletion,
  type AnthropicAdapterOptions,
} from './anthropic-adapter';
export { FakeModelAdapter, type FakeModelScript, type FakeModelStep } from './fake-adapter';
export {
  ModelRoutingPolicy,
  ModelVendor,
  DEFAULT_MODEL_ID,
  routingPolicyFromEnv,
  configureRoutingPolicy,
  setTenantRoutingPolicy,
  registerRoutingPolicySource,
  resetRoutingPolicies,
  routingPolicyFor,
  assertRoutingAllowed,
  type RoutingPolicySource,
} from './routing-policy';
export {
  resolveContextSnapshot,
  defaultContextResolverDeps,
  registerSkillResolver,
  resetSkillResolver,
  resolveSkills,
  registerTenantPolicySource,
  tenantPolicyFor,
  entitlementAutonomy,
  resolveBudget,
  resolveAllowedTools,
  detectSkillConflicts,
  purposeForTask,
  hashContext,
  DEFAULT_RUN_BUDGET,
  type ContextSnapshot,
  type ContextResolveInput,
  type ContextResolverDeps,
  type ResolvedSkill,
  type SkillResolver,
  type TenantPolicySource,
  type ApprovedFactRef,
  type PlaybookEntryRef,
} from './context-resolver';
export {
  assembleSystemPrompt,
  initialUserMessage,
  evidenceBlock,
  PRECEDENCE,
  SECTION_HEADINGS,
  EVIDENCE_OPEN,
  EVIDENCE_CLOSE,
  type PromptInput,
} from './prompt';
export {
  ToolRegistry,
  ProposalRequest,
  type ToolDefinition,
  type AnyToolDefinition,
  type ToolContext,
} from './tool-registry';
export {
  dispatchTool,
  dispatchToolDetailed,
  defaultDispatchDeps,
  assertNoExternalTools,
  ToolDeniedError,
  ToolTimeoutError,
  type AgentRunContext,
  type DispatchDeps,
  type DispatchOutcome,
  type DispatchRecord,
} from './tool-dispatcher';
export { redactForRecord } from './redact';
export {
  MemoryProviderJobStore,
  registerProviderJobStore,
  providerJobs,
  type ProviderJobStore,
} from './provider-jobs';
export * from './tools';
export * from './evaluation';
