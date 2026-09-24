import type { ModelCompletion, ModelRequest, ModelUsage } from '@oremedia/contracts/agents';
import { routingPolicyFromEnv } from './routing-policy';

/** Spec 12.7 / CONVENTIONS "Model calls": every model call goes through ModelAdapter.complete. */
export interface ModelAdapter {
  readonly provider: 'anthropic' | string;
  complete(req: ModelRequest): Promise<ModelCompletion>;
}

/** The model configuration a run records (agent_runs.model_config) and prices its usage with. */
export interface ModelConfig {
  provider: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Price list in micro-units per million tokens; configuration, not a literal at a call site. */
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}

const DEFAULT_INPUT_MICROS_PER_MTOKEN = 5_000_000; // USD 5 / 1M input tokens (placeholder price list, D-08)
const DEFAULT_OUTPUT_MICROS_PER_MTOKEN = 25_000_000; // USD 25 / 1M output tokens

const intFrom = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const policy = routingPolicyFromEnv(env);
  return {
    provider: env['OREMEDIA_MODEL_PROVIDER'] ?? policy.permittedVendors[0] ?? 'anthropic',
    model: policy.defaultModel,
    maxOutputTokens: intFrom(env['OREMEDIA_MODEL_MAX_OUTPUT_TOKENS'], 4096),
    timeoutMs: intFrom(env['OREMEDIA_MODEL_TIMEOUT_MS'], 120_000),
    inputMicrosPerMillionTokens: intFrom(
      env['OREMEDIA_MODEL_INPUT_MICROS_PER_MTOKEN'],
      DEFAULT_INPUT_MICROS_PER_MTOKEN,
    ),
    outputMicrosPerMillionTokens: intFrom(
      env['OREMEDIA_MODEL_OUTPUT_MICROS_PER_MTOKEN'],
      DEFAULT_OUTPUT_MICROS_PER_MTOKEN,
    ),
  };
}

/** Cost of one call in micro-units, rounded up so a run never under-reports (spec 12.6). */
export function estimateCostMicros(config: ModelConfig, usage: ModelUsage): number {
  return Math.ceil(
    (usage.inputTokens * config.inputMicrosPerMillionTokens +
      usage.outputTokens * config.outputMicrosPerMillionTokens) /
      1_000_000,
  );
}
