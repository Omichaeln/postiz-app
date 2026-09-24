import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { estimateCostMicros, modelConfigFromEnv } from './model-adapter';
import {
  DEFAULT_MODEL_ID,
  assertRoutingAllowed,
  registerRoutingPolicySource,
  resetRoutingPolicies,
  routingPolicyFromEnv,
  setTenantRoutingPolicy,
} from './routing-policy';

afterEach(() => resetRoutingPolicies());

describe('model routing policy (spec 12.7)', () => {
  it('the built-in policy permits the configured Anthropic model and denies other vendors', async () => {
    await expect(assertRoutingAllowed('ten_A', 'anthropic', DEFAULT_MODEL_ID)).resolves.toMatchObject({
      defaultModel: DEFAULT_MODEL_ID,
    });
    await expect(assertRoutingAllowed('ten_A', 'fake', 'x')).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(assertRoutingAllowed('ten_A', 'openai', 'gpt')).rejects.toThrow(/not permitted/);
  });

  it('a tenant policy narrows vendors, models and regions', async () => {
    setTenantRoutingPolicy('ten_B', {
      schemaVersion: 1,
      defaultModel: 'claude-sonnet-5',
      permittedVendors: ['anthropic'],
      permittedRegions: ['eu'],
      retention: 'zero',
      dataClasses: ['brand_content'],
      deniedModels: ['claude-opus-5'],
    });
    await expect(assertRoutingAllowed('ten_B', 'anthropic', 'claude-opus-5')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(assertRoutingAllowed('ten_B', 'anthropic', 'claude-sonnet-5', 'us')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(assertRoutingAllowed('ten_B', 'anthropic', 'claude-sonnet-5', 'eu')).resolves.toBeDefined();
    await expect(assertRoutingAllowed('ten_A', 'anthropic', 'claude-opus-5')).resolves.toBeDefined(); // other tenants unaffected
  });

  it('a registered source replaces the in-memory map', async () => {
    registerRoutingPolicySource(async () => ({
      schemaVersion: 1,
      defaultModel: 'm',
      permittedVendors: ['fake'],
      permittedRegions: [],
      retention: 'standard_30d',
      dataClasses: ['brand_content'],
      deniedModels: [],
    }));
    await expect(assertRoutingAllowed('ten_C', 'anthropic', 'claude-opus-5')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await expect(assertRoutingAllowed('ten_C', 'fake', 'm')).resolves.toBeDefined();
  });

  it('the model id is configuration: MODEL_ROUTING_POLICY_REF (a JSON file) and OREMEDIA_MODEL_ID', () => {
    expect(routingPolicyFromEnv({}).defaultModel).toBe(DEFAULT_MODEL_ID);
    expect(routingPolicyFromEnv({ OREMEDIA_MODEL_ID: 'claude-sonnet-5' }).defaultModel).toBe(
      'claude-sonnet-5',
    );
    const dir = mkdtempSync(join(tmpdir(), 'oremedia-routing-'));
    const file = join(dir, 'routing.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: 'claude-opus-4-8',
        permittedVendors: ['anthropic'],
        retention: 'zero',
      }),
    );
    const policy = routingPolicyFromEnv({ MODEL_ROUTING_POLICY_REF: file });
    expect(policy).toMatchObject({
      defaultModel: 'claude-opus-4-8',
      retention: 'zero',
      permittedRegions: [],
    });
    expect(
      modelConfigFromEnv({ MODEL_ROUTING_POLICY_REF: file, OREMEDIA_MODEL_MAX_OUTPUT_TOKENS: '2048' }),
    ).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      maxOutputTokens: 2048,
    });
  });

  it('cost rounds up from the price list', () => {
    const cfg = modelConfigFromEnv({});
    expect(estimateCostMicros(cfg, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      cfg.inputMicrosPerMillionTokens,
    );
    expect(estimateCostMicros(cfg, { inputTokens: 1, outputTokens: 1 })).toBe(
      Math.ceil((cfg.inputMicrosPerMillionTokens + cfg.outputMicrosPerMillionTokens) / 1_000_000),
    );
  });
});
