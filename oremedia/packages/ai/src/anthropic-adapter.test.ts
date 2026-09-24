import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ModelRequest } from '@oremedia/contracts/agents';
import { createModelAdapterFromEnv } from './adapter-factory';
import { AnthropicModelAdapter, anthropicApiKeyFromEnv, toCompletion } from './anthropic-adapter';
import { FakeModelAdapter } from './fake-adapter';

const request: ModelRequest = {
  model: 'claude-opus-5',
  system: 'SYSTEM PROMPT',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Begin.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'facts.list', input: {} }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'toolu_a', content: '{"kind":"denied"}', isError: true }],
    },
  ],
  tools: [
    { name: 'facts.list', description: 'Lists facts', inputSchema: { type: 'object', properties: {} } },
  ],
  maxOutputTokens: 1234,
  temperature: 0.2,
  timeoutMs: 5000,
  metadata: { runId: 'run_1', tenantId: 'ten_A' },
};

const responseBody = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    { type: 'thinking', thinking: 'PRIVATE REASONING', signature: 'sig' },
    { type: 'redacted_thinking', data: 'x' },
    { type: 'text', text: 'Calling a tool.' },
    { type: 'tool_use', id: 'toolu_1', name: 'facts.list', input: { kind: 'offer' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 321, output_tokens: 45 },
};

function fakeFetch(status = 200, body: unknown = responseBody, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
  return { fetch, calls };
}

describe('AnthropicModelAdapter (spec 12.7, tool-use API)', () => {
  it('sends a Messages API tool-use request with the mapped conversation and no sampling parameters', async () => {
    const f = fakeFetch();
    const adapter = new AnthropicModelAdapter({
      apiKey: 'test-key',
      baseURL: 'https://anthropic.invalid',
      fetch: f.fetch as never,
    });
    await adapter.complete(request);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://anthropic.invalid/v1/messages');
    expect(call.method).toBe('POST');
    expect(call.headers.get('x-api-key')).toBe('test-key');
    expect(call.headers.get('anthropic-version')).toBeTruthy();
    expect(call.body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 1234,
      system: 'SYSTEM PROMPT',
      tool_choice: { type: 'auto' },
      metadata: { user_id: 'run_1' },
      tools: [
        { name: 'facts.list', description: 'Lists facts', input_schema: { type: 'object', properties: {} } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Begin.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'facts.list', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: '{"kind":"denied"}', is_error: true },
          ],
        },
      ],
    });
    expect(call.body).not.toHaveProperty('temperature');
    expect(call.body).not.toHaveProperty('thinking');
  });

  it('maps the response to text, tool calls, usage and stop reason, dropping private reasoning blocks', async () => {
    const f = fakeFetch();
    const adapter = new AnthropicModelAdapter({
      apiKey: 'k',
      baseURL: 'https://anthropic.invalid',
      fetch: f.fetch as never,
    });
    const completion = await adapter.complete(request);
    expect(completion).toEqual({
      content: [{ type: 'text', text: 'Calling a tool.' }],
      toolCalls: [{ id: 'toolu_1', name: 'facts.list', arguments: { kind: 'offer' } }],
      usage: { inputTokens: 321, outputTokens: 45 },
      stopReason: 'tool_use',
    });
    expect(JSON.stringify(completion)).not.toContain('PRIVATE REASONING');
    expect(
      toCompletion({ content: [], usage: { input_tokens: 1, output_tokens: 2 } as never, stop_reason: null })
        .stopReason,
    ).toBe('end_turn');
  });

  it('maps 429/5xx to PROVIDER_UNAVAILABLE (retry-after honoured) and 4xx to VALIDATION_FAILED; never retries itself', async () => {
    const limited = fakeFetch(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      { 'retry-after': '7' },
    );
    const adapter = new AnthropicModelAdapter({
      apiKey: 'k',
      baseURL: 'https://anthropic.invalid',
      fetch: limited.fetch as never,
    });
    const err = await adapter.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as ProviderUnavailableError).retryAfterMs).toBe(7000);
    expect(limited.calls).toHaveLength(1);
    const bad = fakeFetch(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } });
    const adapter2 = new AnthropicModelAdapter({
      apiKey: 'k',
      baseURL: 'https://anthropic.invalid',
      fetch: bad.fetch as never,
    });
    await expect(adapter2.complete(request)).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('model adapter configuration (Appendix A)', () => {
  it('reads ANTHROPIC_API_KEY_REF as a mounted file or as the injected value, never the harness ANTHROPIC_API_KEY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oremedia-key-'));
    const file = join(dir, 'anthropic.key');
    writeFileSync(file, 'file-key\n');
    expect(anthropicApiKeyFromEnv({ ANTHROPIC_API_KEY_REF: file, ANTHROPIC_API_KEY: 'harness' })).toBe(
      'file-key',
    );
    expect(anthropicApiKeyFromEnv({ ANTHROPIC_API_KEY_REF: 'inline-key' })).toBe('inline-key');
    expect(anthropicApiKeyFromEnv({ ANTHROPIC_API_KEY: 'harness' })).toBeNull();
    expect(anthropicApiKeyFromEnv({})).toBeNull();
  });

  it('createModelAdapterFromEnv: Anthropic when the ref is set, the fake only outside production, loud otherwise', () => {
    expect(createModelAdapterFromEnv({ ANTHROPIC_API_KEY_REF: 'k' })).toBeInstanceOf(AnthropicModelAdapter);
    expect(createModelAdapterFromEnv({ OREMEDIA_FAKE_MODEL: '1' })).toBeInstanceOf(FakeModelAdapter);
    expect(() => createModelAdapterFromEnv({ OREMEDIA_FAKE_MODEL: '1', NODE_ENV: 'production' })).toThrow(
      /ANTHROPIC_API_KEY_REF is required in production/,
    );
    expect(() => createModelAdapterFromEnv({})).toThrow(/ANTHROPIC_API_KEY_REF is required/);
  });
});
