import type { ModelCompletion, ModelRequest, ModelToolCall, ModelUsage } from '@oremedia/contracts/agents';
import type { ModelAdapter } from './model-adapter';

/** One scripted turn: what the fake model "says" when asked to plan the next step. */
export type FakeModelStep =
  | {
      kind: 'tool_calls';
      toolCalls: Array<Omit<ModelToolCall, 'id'> & { id?: string }>;
      text?: string;
      usage?: ModelUsage;
    }
  | { kind: 'done'; text: string; usage?: ModelUsage }
  | { kind: 'error'; error: Error };

export type FakeModelScript = FakeModelStep[] | ((req: ModelRequest, index: number) => FakeModelStep);

const DEFAULT_USAGE: ModelUsage = { inputTokens: 120, outputTokens: 40 };

/**
 * Scripted adapter for tests and evaluations: returns tool calls or a final answer per step, records every request
 * (system prompt, messages, tools) so tests can assert what the model was shown, and never touches the network.
 */
export class FakeModelAdapter implements ModelAdapter {
  readonly provider = 'fake';
  readonly requests: ModelRequest[] = [];
  private calls = 0;

  constructor(private readonly script: FakeModelScript) {}

  async complete(req: ModelRequest): Promise<ModelCompletion> {
    this.requests.push(structuredClone(req));
    const index = this.calls++;
    const step =
      typeof this.script === 'function'
        ? this.script(req, index)
        : (this.script[index] ?? this.script[this.script.length - 1] ?? { kind: 'done', text: '' });
    if (step.kind === 'error') throw step.error;
    const usage = step.usage ?? DEFAULT_USAGE;
    if (step.kind === 'done')
      return { content: [{ type: 'text', text: step.text }], toolCalls: [], usage, stopReason: 'end_turn' };
    const toolCalls: ModelToolCall[] = step.toolCalls.map((c, i) => ({
      id: c.id ?? `toolu_fake_${index}_${i}`,
      name: c.name,
      arguments: c.arguments,
    }));
    return {
      content: step.text ? [{ type: 'text', text: step.text }] : [],
      toolCalls,
      usage,
      stopReason: 'tool_use',
    };
  }
}
