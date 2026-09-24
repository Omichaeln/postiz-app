import { describe, expect, it } from 'vitest';
import type { ModelToolCall } from '@oremedia/contracts/agents';
import type { PolicyResource, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { TenantContext, Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { MemoryProviderJobStore } from '../provider-jobs';
import { PersonCompletedProposal, type AnyToolDefinition } from '../tool-registry';
import { dispatchToolDetailed, type AgentRunContext, type DispatchDeps } from '../tool-dispatcher';
import { CreateBriefInput, DraftCopyInput } from './content';
import { ProposeScheduleInput, ScheduleProposalPayload } from './publications';
import { RequestReviewInput } from './review';
import { createReleaseOneRegistry, RELEASE_1_TOOLS } from './index';
import {
  NOT_AVAILABLE_YET,
  type ContentToolSource,
  type PublishingToolSource,
  type ReviewToolSource,
  type ToolServices,
} from './services';

/** Spec 12.4 Release 1 tool table: name → effect, action. */
const TABLE: Record<string, [effect: string, action: string]> = {
  'brand.getSnapshot': ['read', 'brand.read'],
  'assets.searchEligible': ['read', 'asset.read'],
  'facts.list': ['read', 'brand.read'],
  'metrics.query': ['read', 'insight.read'],
  'voice.clusters': ['read', 'insight.read'],
  'content.createBrief': ['draft', 'content.plan'],
  'content.draftCopy': ['draft', 'content.edit'],
  'creative.proposeOperations': ['propose', 'creative.edit'],
  'creative.requestRender': ['draft', 'creative.render'],
  'images.generate': ['draft', 'creative.edit'],
  'review.runBrandReview': ['read', 'creative.read'],
  'review.request': ['propose', 'review.request'],
  'experiments.proposeDesign': ['propose', 'experiment.manage'],
  'recommendations.create': ['propose', 'insight.read'],
  'publications.proposeSchedule': ['propose', 'publication.schedule'],
};

const principal: ResolvedActorServicePrincipal = {
  kind: 'service_principal',
  id: 'sp_01HAGENT0000000000000000000',
  tenantId: 'ten_A',
  status: 'active',
  maxAutonomy: 'prepare_release',
  grants: [],
};
const tenantContext: TenantContext = {
  tenantId: 'ten_A',
  actor: { kind: 'service_principal', id: principal.id },
  brandIds: 'all',
  correlationId: 'corr_tools',
};
const run: AgentRunContext = {
  runId: 'run_1',
  stepId: 'step_1',
  tenantId: 'ten_A',
  brandId: 'brd_1',
  correlationId: 'corr_tools',
  tenantContext,
  principal,
  policy: { autonomyMode: 'prepare_release', allowedTools: Object.keys(TABLE) },
  budgetReservationId: null,
  snapshot: null,
};

function harness(sources: Partial<Pick<ToolServices, 'content' | 'review' | 'publishing'>>) {
  const resources: Array<{ action: string; resource: PolicyResource }> = [];
  const deps: DispatchDeps = {
    registry: createReleaseOneRegistry(),
    policy: {
      decide: async (_actor, action, resource) => {
        resources.push({ action, resource });
        return { allowed: true, reason: 'ok' };
      },
    },
    audit: { record: async () => 'aud_1' },
    budgets: { consume: async () => undefined },
    services: { content: null, review: null, publishing: null, ...sources } as ToolServices,
    providerJobs: new MemoryProviderJobStore(),
    transaction: (fn) => fn({} as Tx),
  };
  return { deps, resources };
}
const call = (name: string, args: unknown): ModelToolCall => ({ id: 'toolu_1', name, arguments: args });

describe('Release 1 tools (spec 12.4 table)', () => {
  it('every tool has the effect and action of the table and a JSON schema whose required keys exist', () => {
    expect(RELEASE_1_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(TABLE).sort());
    for (const def of RELEASE_1_TOOLS as AnyToolDefinition[]) {
      expect([def.effect, def.action], def.name).toEqual(TABLE[def.name]);
      const schema = def.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      for (const key of schema.required ?? [])
        expect(schema.properties, `${def.name}.${key}`).toHaveProperty(key);
    }
  });

  it('no tool is unavailable once every source is registered (nothing denies unconditionally)', () => {
    const services = {
      intelligence: {},
      content: {},
      review: {},
      publishing: {},
      images: {},
    } as unknown as ToolServices;
    for (const def of RELEASE_1_TOOLS as AnyToolDefinition[])
      expect(def.availability?.({ services, run }) ?? null, def.name).toBeNull();
  });

  it('input schemas: strict, bounded, and the model sees the same required keys', () => {
    expect(CreateBriefInput.safeParse({ audience: 'Buyers', message: 'June offer' }).success).toBe(true);
    expect(CreateBriefInput.safeParse({ audience: 'Buyers', message: '' }).success).toBe(false);
    expect(CreateBriefInput.safeParse({ audience: 'a', message: 'b', brandId: 'brd_x' }).success).toBe(false);
    expect(
      CreateBriefInput.safeParse({ audience: 'a', message: 'b', offerFactIds: Array(21).fill('f') }).success,
    ).toBe(false);
    expect(DraftCopyInput.safeParse({ briefId: 'b', variants: [] }).success).toBe(false);
    expect(
      DraftCopyInput.parse({ briefId: 'b', variants: [{ text: 'Caption', rationale: 'why' }] }).variants[0],
    ).toEqual({ text: 'Caption', rationale: 'why', factIds: [] });
    expect(RequestReviewInput.safeParse({ contentRevisionId: 'r', timing: { kind: 'exact' } }).success).toBe(
      false,
    );
    expect(
      RequestReviewInput.parse({
        contentRevisionId: 'r',
        timing: { kind: 'window', from: '2026-10-01T09:00:00Z', to: '2026-10-01T17:00:00Z' },
      }).reviewerUserIds,
    ).toEqual([]);
    expect(
      ProposeScheduleInput.safeParse({
        contentRevisionId: 'r',
        channelConnectionIds: [],
        proposedAt: '2026-10-01T09:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('hook-backed tools deny tool_not_available_yet until their source registers, after the policy decision', async () => {
    const h = harness({});
    for (const [name, args] of [
      ['content.createBrief', { audience: 'a', message: 'b' }],
      ['content.draftCopy', { briefId: 'brf_1', variants: [{ text: 't', rationale: 'r' }] }],
      [
        'review.request',
        { contentRevisionId: 'cr_1', timing: { kind: 'exact', at: '2026-10-01T09:00:00Z' } },
      ],
      [
        'publications.proposeSchedule',
        { contentRevisionId: 'cr_1', channelConnectionIds: ['cc_1'], proposedAt: '2026-10-01T09:00:00Z' },
      ],
    ] as const) {
      const out = await dispatchToolDetailed(call(name, args), run, h.deps);
      expect(out.result, name).toEqual({ kind: 'denied', reason: NOT_AVAILABLE_YET });
      expect(out.record.policyDecision).toBe('allowed');
    }
    expect(h.resources.map((r) => r.action)).toEqual([
      'content.plan',
      'content.edit',
      'review.request',
      'publication.schedule',
    ]);
  });

  it('content tools pass the run brand, run id and autonomy mode to the source; draftCopy is authorised on the brief', async () => {
    const seen: unknown[] = [];
    const content: ContentToolSource = {
      async createBrief(actor, input) {
        seen.push({ actor: actor.id, ...input });
        return { briefId: 'brf_new' };
      },
      async draftCopy(_actor, input) {
        seen.push(input);
        return {
          drafts: input.variants.map((_, i) => ({
            contentPackageId: `cp_${i}`,
            contentRevisionId: `cr_${i}`,
            contentHash: 'h'.repeat(64),
          })),
        };
      },
    };
    const h = harness({ content });
    const brief = await dispatchToolDetailed(
      call('content.createBrief', { audience: 'Buyers', message: 'June', campaignId: 'cmp_1' }),
      run,
      h.deps,
    );
    expect(brief.result).toEqual({ kind: 'ok', output: { briefId: 'brf_new', state: 'draft' } });
    expect(seen[0]).toEqual({
      actor: principal.id,
      brandId: 'brd_1',
      runId: 'run_1',
      autonomyMode: 'prepare_release',
      campaignId: 'cmp_1',
      audience: 'Buyers',
      message: 'June',
      offerFactIds: [],
      channelConnectionIds: [],
      constraints: [],
    });
    const drafted = await dispatchToolDetailed(
      call('content.draftCopy', {
        briefId: 'brf_new',
        variants: [
          { text: 'One', factIds: ['fct_1'], rationale: 'r1' },
          { text: 'Two', rationale: 'r2' },
        ],
      }),
      run,
      h.deps,
    );
    expect(drafted.result).toMatchObject({ kind: 'ok', output: { state: 'draft' } });
    expect(
      drafted.result.kind === 'ok' && (drafted.result.output as { drafts: unknown[] }).drafts,
    ).toHaveLength(2);
    expect(h.resources[1]).toEqual({
      action: 'content.edit',
      resource: { type: 'brief', tenantId: 'ten_A', brandId: 'brd_1', id: 'brf_new' },
    });
  });

  it('review.request opens a request through the source and reports it open', async () => {
    const review: ReviewToolSource = {
      async requestReview(_actor, input) {
        expect(input).toEqual({
          brandId: 'brd_1',
          runId: 'run_1',
          autonomyMode: 'prepare_release',
          contentRevisionId: 'cr_1',
          assigneeUserIds: ['usr_1'],
          timing: { kind: 'exact', at: '2026-10-01T09:00:00Z' },
        });
        return { reviewRequestId: 'rr_1', manifestHash: 'm'.repeat(64) };
      },
    };
    const h = harness({ review });
    const out = await dispatchToolDetailed(
      call('review.request', {
        contentRevisionId: 'cr_1',
        reviewerUserIds: ['usr_1'],
        timing: { kind: 'exact', at: '2026-10-01T09:00:00Z' },
      }),
      run,
      h.deps,
    );
    expect(out.result).toEqual({
      kind: 'ok',
      output: { reviewRequestId: 'rr_1', manifestHash: 'm'.repeat(64), state: 'open' },
    });
    expect(h.resources[0]!.resource).toMatchObject({ type: 'content_revision', id: 'cr_1' });
  });

  it('publications.proposeSchedule always ends in proposal_requires_user with a person-completed payload', async () => {
    const publishing: PublishingToolSource = {
      async proposeSchedule(_actor, input) {
        return {
          entries: input.channelConnectionIds.map((c) => ({
            channelConnectionId: c,
            channelVariantId: `cv_${c}`,
            scheduledFor: input.proposedAt,
          })),
        };
      },
    };
    const h = harness({ publishing });
    const out = await dispatchToolDetailed(
      call('publications.proposeSchedule', {
        contentRevisionId: 'cr_1',
        channelConnectionIds: ['cc_1', 'cc_2'],
        proposedAt: '2026-10-01T09:00:00.000Z',
        rationale: 'Tuesday morning performs best',
      }),
      run,
      h.deps,
    );
    const payload = {
      completion: 'person',
      command: 'publications.schedule',
      contentRevisionId: 'cr_1',
      entries: [
        {
          channelConnectionId: 'cc_1',
          channelVariantId: 'cv_cc_1',
          scheduledFor: '2026-10-01T09:00:00.000Z',
        },
        {
          channelConnectionId: 'cc_2',
          channelVariantId: 'cv_cc_2',
          scheduledFor: '2026-10-01T09:00:00.000Z',
        },
      ],
      rationale: 'Tuesday morning performs best',
    };
    expect(out.result).toEqual({
      kind: 'proposal_requires_user',
      stepId: 'step_1',
      proposalRef: hashCanonical(payload),
    });
    expect(out.record).toMatchObject({ outcome: 'proposal', proposal: payload });
    expect(ScheduleProposalPayload.parse(out.record.proposal)).toEqual(payload);
    expect(PersonCompletedProposal.safeParse(out.record.proposal).success).toBe(true);
  });
});
