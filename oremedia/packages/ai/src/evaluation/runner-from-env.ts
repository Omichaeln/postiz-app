import { createModelAdapterFromEnv } from '../adapter-factory';
import { modelConfigFromEnv } from '../model-adapter';
import type { ToolRegistry } from '../tool-registry';
import { evaluationBrandFixtures } from './fixtures';
import { createEvaluationRunner, type EvaluationRunner } from './run-evaluation';

/**
 * The runner a composition root registers with skillsService.registerEvaluationRunner. Adapters are built on first
 * use from the environment (ANTHROPIC_API_KEY_REF, or the scripted fake outside production), so wiring never fails
 * at start-up; an evaluation without a configured model fails with that error at the call.
 */
export function createEvaluationRunnerFromEnv(
  registry: ToolRegistry,
  env: NodeJS.ProcessEnv = process.env,
): EvaluationRunner {
  let runner: EvaluationRunner | null = null;
  return (suite) => {
    if (!runner) {
      const adapter = createModelAdapterFromEnv(env);
      const config = modelConfigFromEnv(env);
      runner = createEvaluationRunner({
        adapter,
        grader: adapter, // a separate call, and a separate model when OREMEDIA_GRADER_MODEL_ID names one
        brandFixtures: evaluationBrandFixtures(),
        registry,
        model: config.model,
        graderModel: env['OREMEDIA_GRADER_MODEL_ID'] ?? config.model,
      });
    }
    return runner(suite);
  };
}
