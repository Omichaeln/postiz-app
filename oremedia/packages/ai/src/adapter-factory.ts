import { createAnthropicAdapterFromEnv } from './anthropic-adapter';
import { FakeModelAdapter } from './fake-adapter';
import type { ModelAdapter } from './model-adapter';

/**
 * Appendix A: ANTHROPIC_API_KEY_REF selects the Anthropic adapter. Without it, production fails loudly at startup;
 * outside production OREMEDIA_FAKE_MODEL=1 selects the scripted fake (a model that always finishes) for local runs.
 */
export function createModelAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  const anthropic = createAnthropicAdapterFromEnv(env);
  if (anthropic) return anthropic;
  const production = env['NODE_ENV'] === 'production';
  if (!production && env['OREMEDIA_FAKE_MODEL'] === '1')
    return new FakeModelAdapter([{ kind: 'done', text: '{"note":"fake model: no work performed"}' }]);
  throw new Error(
    production
      ? 'ANTHROPIC_API_KEY_REF is required in production (no model adapter configured)'
      : 'ANTHROPIC_API_KEY_REF is required (set OREMEDIA_FAKE_MODEL=1 for the scripted fake outside production)',
  );
}
