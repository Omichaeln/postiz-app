import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelCompletion,
  ModelContent,
  ModelMessage,
  ModelRequest,
  ModelToolCall,
} from '@oremedia/contracts/agents';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import { logger } from '@oremedia/observability';
import type { ModelAdapter } from './model-adapter';

type ClientOptions = NonNullable<ConstructorParameters<typeof Anthropic>[0]>;

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** Explicit so the SDK never reads ANTHROPIC_BASE_URL from the process environment. */
  baseURL?: string;
  /** Test seam: the SDK's fetch implementation (request shape and response mapping are unit-tested through it). */
  fetch?: ClientOptions['fetch'];
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Spec 12.7: the official SDK, current tool-use API. Retries belong to Temporal (maxRetries 0); the request timeout
 * is the caller's timeoutMs. Prompts and content are never logged; private reasoning blocks (`thinking`,
 * `redacted_thinking`) are stripped from the response and never stored. Sampling parameters are not sent: current
 * Anthropic models reject them, so `temperature` on the request is accepted by the interface and ignored here.
 */
export class AnthropicModelAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  private readonly client: Anthropic;

  constructor(opts: AnthropicAdapterOptions) {
    const options: ClientOptions = {
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
      maxRetries: 0,
    };
    if (opts.fetch) options.fetch = opts.fetch;
    this.client = new Anthropic(options);
  }

  async complete(req: ModelRequest): Promise<ModelCompletion> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: req.messages.map(toSdkMessage),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      tool_choice: { type: 'auto' },
      metadata: { user_id: req.metadata.runId },
    };
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params, { timeout: req.timeoutMs, maxRetries: 0 });
    } catch (err) {
      throw mapError(err);
    }
    return toCompletion(message);
  }
}

function toSdkMessage(m: ModelMessage): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = m.content.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'tool_use':
        return { type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: part.toolUseId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        };
    }
  });
  return { role: m.role, content };
}

/** Maps the response: text and tool_use blocks only; every other block type (reasoning, server tools) is dropped. */
export function toCompletion(
  message: Pick<Anthropic.Message, 'content' | 'usage' | 'stop_reason'>,
): ModelCompletion {
  const content: ModelContent[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use')
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
  }
  return {
    content,
    toolCalls,
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    stopReason: message.stop_reason ?? 'end_turn',
  };
}

function mapError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 429 || status >= 500 || status === 0) {
      const retryAfter = Number(err.headers?.get('retry-after'));
      logger().warn({ errorMessage: `anthropic status ${status}` }, 'model provider unavailable');
      return new ProviderUnavailableError(
        'anthropic',
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    return new ValidationFailedError(
      [{ path: 'model', issue: `provider rejected the request (${status})` }],
      'The model provider rejected the request',
    );
  }
  if (err instanceof Anthropic.APIConnectionError) return new ProviderUnavailableError('anthropic');
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * ANTHROPIC_API_KEY_REF (Appendix A) is a reference the platform resolves: a mounted secret file path, or the key
 * material itself when the secret manager injects the value. The harness variables ANTHROPIC_API_KEY /
 * ANTHROPIC_BASE_URL are never read.
 */
export function anthropicApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const ref = env['ANTHROPIC_API_KEY_REF'];
  if (!ref) return null;
  const value = existsSync(ref) ? readFileSync(ref, 'utf8') : ref;
  const key = value.trim();
  return key.length ? key : null;
}

export function createAnthropicAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicModelAdapter | null {
  const apiKey = anthropicApiKeyFromEnv(env);
  if (!apiKey) return null;
  const baseURL = env['OREMEDIA_ANTHROPIC_BASE_URL'];
  return new AnthropicModelAdapter(baseURL ? { apiKey, baseURL } : { apiKey });
}
