import { describe, expect, it } from 'vitest';
import { AgentRunState } from '@oremedia/contracts/agents';
import {
  formatDuration,
  formatMicros,
  isTerminalState,
  mergeRunIds,
  modifyBatchOf,
  needsAttention,
  pendingProposal,
  proposalPayloadOf,
  recordedException,
  runStateChip,
} from './run-helpers';
import { auditRunIds, type AuditEventDto, type RunDto, type StepDto } from './use-agent-runs';

const run = (state: RunDto['state'], costMicros = 0): RunDto => ({
  id: 'run_1',
  brandId: 'brd_1',
  state,
  taskKind: 'copywriting',
  autonomyMode: 'create',
  servicePrincipalId: 'sp_1',
  initiatorKind: 'user',
  initiatorId: 'usr_1',
  brief: {},
  contextSnapshotHash: null,
  skillVersionIds: [],
  modelConfig: { provider: 'anthropic', model: 'm' },
  budgetReservationId: null,
  costMicros,
  deadlineAt: '2026-01-01T00:00:00.000Z',
  workflowId: 'run:run_1',
  correlationId: 'c',
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 0,
});

const invocation = (over: Partial<StepDto['invocations'][number]>): StepDto['invocations'][number] => ({
  id: 'ti_1',
  toolName: 'facts.list',
  inputHash: 'a'.repeat(64),
  inputRedacted: {},
  policyDecision: 'allowed',
  policyReason: null,
  outcome: 'ok',
  outputRef: 'ok',
  proposal: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const step = (over: Partial<StepDto>): StepDto => ({
  id: 'st_1',
  index: 0,
  kind: 'tool_call',
  summary: 'a step',
  tokensIn: 0,
  tokensOut: 0,
  costMicros: 0,
  durationMs: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  invocations: [],
  ...over,
});

describe('run state chips', () => {
  it('every contract state has a chip with a label and a tone (never colour alone)', () => {
    for (const state of AgentRunState.options) {
      const chip = runStateChip(state);
      expect(chip.label.length).toBeGreaterThan(0);
      expect(['neutral', 'good', 'warning', 'critical', 'info']).toContain(chip.tone);
    }
    expect(runStateChip('planned')).toEqual({ tone: 'info', label: 'Queued' });
    expect(runStateChip('waiting_for_review').tone).toBe('warning');
    expect(runStateChip('budget_exhausted').tone).toBe('critical');
    expect(runStateChip('policy_denied').tone).toBe('critical');
    expect(runStateChip('cancelled').tone).toBe('neutral');
  });
  it('terminal states are the six finish states', () => {
    expect(AgentRunState.options.filter(isTerminalState)).toEqual([
      'completed',
      'failed',
      'cancelled',
      'budget_exhausted',
      'policy_denied',
      'waiting_expired',
    ]);
  });
});

describe('money and time', () => {
  it('converts micros to currency and never shows raw micros', () => {
    expect(formatMicros(0, 'USD', 'en-US')).toBe('$0.00');
    expect(formatMicros(1_500_000, 'USD', 'en-US')).toBe('$1.50');
    expect(formatMicros(12_340_000, 'USD', 'en-US')).toBe('$12.34');
    expect(formatMicros(1500, 'USD', 'en-US')).toBe('$0.0015'); // sub-cent costs keep their precision
    expect(formatMicros(12_340, 'USD', 'en-US')).toBe('$0.0123');
    expect(formatMicros(9_990, 'USD', 'en-US')).toBe('$0.01');
    expect(formatMicros(999_990, 'USD', 'en-US')).toBe('$1.00');
    expect(formatMicros(2_500, 'EUR', 'en-US')).toBe('€0.0025');
  });
  it('formats durations for reading', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(2_300)).toBe('2.3 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});

describe('needs attention', () => {
  it('waiting, cancelled, budget exhausted, policy denied and expired each have a named item', () => {
    expect(needsAttention(run('waiting_for_review'), [])[0]?.title).toBe('Waiting for your decision');
    expect(needsAttention(run('cancelled'), [])[0]?.tone).toBe('neutral');
    const budget = needsAttention(run('budget_exhausted', 2_500_000), [])[0];
    expect(budget?.title).toBe('Budget exhausted');
    expect(budget?.detail).toContain('$2.50');
    expect(needsAttention(run('waiting_expired'), [])[0]?.title).toBe('Review expired');
    expect(needsAttention(run('completed'), [])).toEqual([]);
  });
  it('policy denied names the denied tool and its recorded reason once', () => {
    const steps = [
      step({
        invocations: [
          invocation({
            toolName: 'publications.proposeSchedule',
            policyDecision: 'denied',
            outcome: 'denied',
            policyReason: 'autonomy_below_prepare_release',
            outputRef: 'autonomy_below_prepare_release',
          }),
        ],
      }),
    ];
    const items = needsAttention(run('policy_denied'), steps);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toContain('publications.proposeSchedule');
    expect(items[0]?.detail).toContain('autonomy_below_prepare_release');
  });
  it('failed surfaces the recorded exception; other denials and invalid inputs are listed too', () => {
    const steps = [
      step({
        id: 'st_1',
        invocations: [invocation({ id: 'ti_1', policyDecision: 'invalid', outcome: 'invalid' })],
      }),
      step({
        id: 'st_2',
        index: 1,
        invocations: [
          invocation({
            id: 'ti_2',
            toolName: 'images.generate',
            outcome: 'error',
            outputRef: 'provider_unavailable',
          }),
        ],
      }),
    ];
    expect(recordedException(steps)).toBe('images.generate: provider_unavailable');
    const items = needsAttention(run('failed'), steps);
    expect(items[0]).toMatchObject({ tone: 'critical', title: 'Failed' });
    expect(items[0]?.detail).toContain('images.generate: provider_unavailable');
    expect(items.some((i) => i.title === 'Invalid input: facts.list')).toBe(true);
    expect(recordedException([step({ summary: 'context_changed' })])).toBe('context_changed');
    expect(recordedException([])).toBeNull();
  });
});

describe('proposals', () => {
  const payload = {
    documentId: 'doc_1',
    baseRevisionId: 'rev_1',
    operations: [{ op: 'setText', pageId: 'p', elementId: 'e', text: 't' }],
    summary: 'Tighten the headline',
    contentHash: 'h',
    findings: [{ code: 'x', severity: 'warning', message: 'long headline' }],
  };
  it('takes the newest proposal invocation of the run, verbatim', () => {
    const steps = [
      step({
        id: 'st_1',
        invocations: [
          invocation({ id: 'ti_1', outcome: 'proposal', proposal: { ...payload, summary: 'older' } }),
        ],
      }),
      step({
        id: 'st_2',
        index: 1,
        invocations: [invocation({ id: 'ti_2', outcome: 'proposal', proposal: payload })],
      }),
    ];
    const p = pendingProposal(steps);
    expect(p?.stepId).toBe('st_2');
    expect(p?.payload.summary).toBe('Tighten the headline');
    expect(p?.payload.findings).toEqual([{ severity: 'warning', message: 'long headline' }]);
    expect(pendingProposal([step({})])).toBeNull();
    expect(proposalPayloadOf({ documentId: 'd' })).toBeNull();
    expect(proposalPayloadOf('nope')).toBeNull();
  });
  it('the modify batch is what the server validates (origin is added by the server)', () => {
    const p = proposalPayloadOf(payload);
    expect(p).not.toBeNull();
    const batch = JSON.parse(modifyBatchOf(p!)) as Record<string, unknown>;
    expect(Object.keys(batch).sort()).toEqual(['baseRevisionId', 'documentId', 'operations', 'summary']);
    expect(batch['documentId']).toBe('doc_1');
  });
});

describe('run discovery', () => {
  const event = (resourceId: string, brandId: string | null, id: string): AuditEventDto => ({
    id,
    tenantId: 'ten_1',
    actorKind: 'user',
    actorId: 'usr_1',
    supportSessionId: null,
    action: 'agent.run.request',
    resourceType: 'agent_run',
    resourceId,
    decision: 'allowed',
    reason: null,
    correlationId: 'c',
    metadata: brandId ? { brandId, runId: resourceId } : null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  it('keeps the brand’s runs in audit order without duplicates', () => {
    const ids = auditRunIds(
      [
        event('run_b', 'brd_1', '3'),
        event('run_a', 'brd_1', '2'),
        event('run_b', 'brd_1', '1'),
        event('run_x', 'brd_2', '0'),
        event('run_y', null, '-1'),
      ],
      'brd_1',
    );
    expect(ids).toEqual(['run_b', 'run_a']);
  });
  it('merges audit and device ids, audit first, without duplicates', () => {
    expect(mergeRunIds(['run_b', 'run_a'], ['run_a', 'run_c'])).toEqual(['run_b', 'run_a', 'run_c']);
    expect(mergeRunIds([], [])).toEqual([]);
  });
});
