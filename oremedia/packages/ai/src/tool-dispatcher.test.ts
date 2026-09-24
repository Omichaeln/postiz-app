import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelToolCall } from '@oremedia/contracts/agents';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Decision, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { TOOL_NAMES_RELEASE_1 } from '@oremedia/contracts/skills';
import type { TenantContext, Tx } from '@oremedia/db';
import { MemoryProviderJobStore } from './provider-jobs';
import { ProposalRequest, ToolRegistry, type ToolDefinition } from './tool-registry';
import {
  assertNoExternalTools,
  dispatchTool,
  dispatchToolDetailed,
  type AgentRunContext,
  type DispatchDeps,
} from './tool-dispatcher';
import { createReleaseOneRegistry } from './tools';
import type { ToolServices } from './tools/services';

const principal: ResolvedActorServicePrincipal = {
  kind: 'service_principal',
  id: 'sp_01HAGENT0000000000000000000',
  tenantId: 'ten_A',
  status: 'active',
  maxAutonomy: 'create',
  grants: [{ action: 'brand.read', brandIds: 'all' }],
};
const tenantContext: TenantContext = {
  tenantId: 'ten_A',
  actor: { kind: 'service_principal', id: principal.id },
  brandIds: 'all',
  correlationId: 'corr_dispatch',
};

const echoTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  name: 'echo.tool',
  description: 'echo',
  input: z.object({ text: z.string().min(1) }).strict(),
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  output: z.object({ echoed: z.string() }),
  action: 'brand.read',
  effect: 'read',
  async run(input) {
    return { echoed: input.text };
  },
};
const costedTool: ToolDefinition<{ n: number }, { ok: true }> = {
  name: 'costed.tool',
  description: 'costed',
  input: z.object({ n: z.number().int().min(1) }),
  inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
  output: z.object({ ok: z.literal(true) }),
  action: 'creative.edit',
  effect: 'draft',
  costKind: 'image_generation',
  costEstimateMicros: (i) => i.n * 1000,
  async run() {
    return { ok: true };
  },
};
const proposalTool: ToolDefinition<{ text: string }, { never: true }> = {
  name: 'propose.tool',
  description: 'propose',
  input: z.object({ text: z.string().min(1) }).strict(),
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  output: z.object({ never: z.literal(true) }),
  action: 'creative.edit',
  effect: 'propose',
  async run(input) {
    return new ProposalRequest(`ref:${input.text}`, { text: input.text });
  },
};
const slowTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  ...echoTool,
  name: 'slow.tool',
  timeoutMs: 20,
  run: () => new Promise((resolve) => setTimeout(() => resolve({ echoed: 'late' }), 200)),
};
const notFoundTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  ...echoTool,
  name: 'missing.tool',
  async run() {
    throw new NotFoundError('CreativeDocument', 'doc_x');
  },
};
const explodingTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  ...echoTool,
  name: 'exploding.tool',
  async run() {
    throw new Error('connection reset');
  },
};
const unavailableTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  ...echoTool,
  name: 'unavailable.tool',
  availability: () => 'provider_not_configured',
};

function harness(opts: { deny?: string; allowed?: string[]; reservation?: string | null } = {}) {
  const registry = new ToolRegistry()
    .register(echoTool)
    .register(costedTool)
    .register(proposalTool)
    .register(slowTool)
    .register(notFoundTool)
    .register(explodingTool)
    .register(unavailableTool);
  const audits: Array<{ action: string; decision: Decision | string; metadata?: Record<string, unknown> }> =
    [];
  const decisions: Array<{ action: string; autonomyMode?: string }> = [];
  const consumed: Array<{ reservationId: string; kind: string; costMicros: number; sourceRef: string }> = [];
  const deps: DispatchDeps = {
    registry,
    policy: {
      decide: async (_actor, action, _resource, o) => {
        decisions.push({ action, autonomyMode: o?.autonomyMode });
        return opts.deny === action
          ? { allowed: false, reason: 'grant_missing' }
          : { allowed: true, reason: 'ok' };
      },
    },
    audit: {
      record: async (_actor, action, _resource, decision, _tx, metadata) => {
        audits.push({ action, decision, metadata });
        return 'aud_1';
      },
    },
    budgets: {
      consume: async (reservationId, _brandId, kind, _q, _u, costMicros, sourceRef) => {
        consumed.push({ reservationId, kind, costMicros, sourceRef });
      },
    },
    services: {} as ToolServices,
    providerJobs: new MemoryProviderJobStore(),
    transaction: (fn) => fn({} as Tx),
  };
  const run: AgentRunContext = {
    runId: 'run_1',
    stepId: 'step_1',
    tenantId: 'ten_A',
    brandId: 'brd_1',
    correlationId: 'corr_dispatch',
    tenantContext,
    principal,
    policy: {
      autonomyMode: 'create',
      allowedTools: opts.allowed ?? [
        'echo.tool',
        'costed.tool',
        'propose.tool',
        'slow.tool',
        'missing.tool',
        'exploding.tool',
        'unavailable.tool',
      ],
    },
    budgetReservationId: opts.reservation === undefined ? 'br_1' : opts.reservation,
    snapshot: null,
  };
  return { deps, run, audits, decisions, consumed };
}
const call = (name: string, args: unknown): ModelToolCall => ({ id: 'toolu_1', name, arguments: args });

describe('dispatchTool (spec 12.4)', () => {
  it('denies an unknown tool before anything else: no policy call, no schema parse, only the denial audited', async () => {
    const h = harness();
    const out = await dispatchToolDetailed(
      call('publications.publishNow', { approval: 'granted' }),
      h.run,
      h.deps,
    );
    expect(out.result).toEqual({ kind: 'denied', reason: 'tool_not_allowed' });
    expect(out.record).toMatchObject({
      policyDecision: 'denied',
      policyReason: 'tool_not_allowed',
      outcome: 'denied',
    });
    expect(h.decisions).toEqual([]);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'agent.tool.denied',
        metadata: expect.objectContaining({
          toolName: 'publications.publishNow',
          reason: 'tool_not_allowed',
        }),
      }),
    ]);
  });

  it('denies a registered tool that the run does not list (a skill or grant did not allow it)', async () => {
    const h = harness({ allowed: ['costed.tool'] });
    expect(await dispatchTool(call('echo.tool', { text: 'x' }), h.run, h.deps)).toEqual({
      kind: 'denied',
      reason: 'tool_not_allowed',
    });
    expect(h.decisions).toEqual([]);
  });

  it('returns invalid with issues for a schema failure (counts as a step) without authorising or auditing', async () => {
    const h = harness();
    const out = await dispatchToolDetailed(call('echo.tool', { text: '' }), h.run, h.deps);
    expect(out.result.kind).toBe('invalid');
    if (out.result.kind === 'invalid') expect(out.result.issues[0]?.path).toBe('text');
    expect(out.record).toMatchObject({ policyDecision: 'invalid', outcome: 'invalid' });
    expect(h.decisions).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('authorises the service principal for the tool action with the run autonomy mode, audits, then runs', async () => {
    const h = harness();
    const out = await dispatchToolDetailed(call('echo.tool', { text: 'hello' }), h.run, h.deps);
    expect(out.result).toEqual({ kind: 'ok', output: { echoed: 'hello' } });
    expect(h.decisions).toEqual([{ action: 'brand.read', autonomyMode: 'create' }]);
    expect(h.audits[0]).toMatchObject({
      action: 'agent.tool.echo.tool',
      decision: { allowed: true, reason: 'ok' },
    });
    expect(out.record.inputHash).toHaveLength(64);
    expect(out.record.inputRedacted).toEqual({ text: 'hello' });
  });

  it('returns the policy denial reason and audits it', async () => {
    const h = harness({ deny: 'creative.edit' });
    expect(await dispatchTool(call('costed.tool', { n: 1 }), h.run, h.deps)).toEqual({
      kind: 'denied',
      reason: 'grant_missing',
    });
    expect(h.audits[0]).toMatchObject({
      action: 'agent.tool.costed.tool',
      decision: { allowed: false, reason: 'grant_missing' },
    });
    expect(h.consumed).toEqual([]);
  });

  it('consumes the estimate from the reservation before running a costed tool', async () => {
    const h = harness();
    expect(await dispatchTool(call('costed.tool', { n: 3 }), h.run, h.deps)).toEqual({
      kind: 'ok',
      output: { ok: true },
    });
    expect(h.consumed).toEqual([
      { reservationId: 'br_1', kind: 'image_generation', costMicros: 3000, sourceRef: 'step_1' },
    ]);
  });

  it('denies a costed tool when the run holds no reservation', async () => {
    const h = harness({ reservation: null });
    expect(await dispatchTool(call('costed.tool', { n: 3 }), h.run, h.deps)).toEqual({
      kind: 'denied',
      reason: 'no_budget_reservation',
    });
  });

  it('denies an unavailable tool after policy and before any spend', async () => {
    const h = harness();
    expect(await dispatchTool(call('unavailable.tool', { text: 'x' }), h.run, h.deps)).toEqual({
      kind: 'denied',
      reason: 'provider_not_configured',
    });
    expect(h.decisions).toHaveLength(1);
  });

  it('turns a ProposalRequest into proposal_requires_user with the step id', async () => {
    const h = harness();
    const out = await dispatchToolDetailed(call('propose.tool', { text: 'swap' }), h.run, h.deps);
    expect(out.result).toEqual({ kind: 'proposal_requires_user', stepId: 'step_1', proposalRef: 'ref:swap' });
    expect(out.record.outcome).toBe('proposal');
  });

  it('maps a timeout to a denial, a domain error to its reason, and rethrows infrastructure failures', async () => {
    const h = harness();
    expect(await dispatchTool(call('slow.tool', { text: 'x' }), h.run, h.deps)).toEqual({
      kind: 'denied',
      reason: 'tool_timeout',
    });
    expect(await dispatchTool(call('missing.tool', { text: 'x' }), h.run, h.deps)).toEqual({
      kind: 'denied',
      reason: 'not_found',
    });
    await expect(dispatchTool(call('exploding.tool', { text: 'x' }), h.run, h.deps)).rejects.toThrow(
      'connection reset',
    );
  });

  it('redacts credential-like keys in the recorded input', async () => {
    const h = harness();
    const out = await dispatchToolDetailed(
      call('echo.tool', { text: 'x', apiKey: 'sk-secret' }),
      h.run,
      h.deps,
    );
    // strict schema: the extra key is invalid, but the record is still redacted
    expect(out.record.inputRedacted).toEqual({ text: 'x', apiKey: '[redacted]' });
  });
});

describe('tool registry (spec 12.4)', () => {
  it('refuses a tool with effect external: no agent tool publishes', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...echoTool, name: 'publish.now', effect: 'external' })).toThrow(
      /external/,
    );
  });

  it('ships exactly the Release 1 table, none external, schemas only for allowed tools', () => {
    const registry = createReleaseOneRegistry();
    expect(registry.names()).toEqual([...TOOL_NAMES_RELEASE_1].sort());
    expect(() => assertNoExternalTools(registry)).not.toThrow();
    expect(registry.schemasFor(['facts.list', 'nope']).map((s) => s.name)).toEqual(['facts.list']);
    for (const name of registry.names()) {
      const def = registry.get(name);
      expect(def?.inputSchema['type']).toBe('object');
    }
  });
});
