import { createHash, randomUUID } from 'node:crypto';
import {
  BriefAccept,
  BriefCreate,
  BriefGet,
  BriefList,
  CampaignCreate,
  CampaignGet,
  CampaignList,
  ChannelVariantGenerate,
  ContentPackageCreate,
  ContentPackageGet,
  ContentPackageRevise,
} from '@oremedia/contracts/content';
import {
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import {
  ExperimentCreate,
  ExperimentGet,
  ExperimentList,
  ExperimentPreRegister,
  ExperimentResults,
  ExperimentResultsGet,
  ExperimentStart,
  ExperimentStop,
  PreRegistrationV1,
  conclusionLabelFor,
  type ExperimentMode,
} from '@oremedia/contracts/experiments';
import {
  AnalystRun,
  AnomalyList,
  PlaybookApprove,
  PlaybookList,
  PlaybookPropose,
  RecommendationAccept,
  RecommendationDismiss,
  VoiceClustersList,
  WorkspaceGet,
  type EvidenceStrength,
  type RecommendationAction,
} from '@oremedia/contracts/intelligence';
import {
  ChannelConnectComplete,
  ChannelConnectStart,
  ChannelDisconnect,
} from '@oremedia/contracts/publishing';
import type { MockBuilders, t } from './mock-api';
import type { Channel, Phase5Backend, Phase5Extensions } from './mock-phase5';
import { P5 } from './mock-phase5';

/**
 * Phase 6 slice of the UI-only transport (see mock-api.ts): the intelligence workspace, experiments, campaigns,
 * briefs, content packages and channel connections with the same procedure paths, DTO shapes and error envelope as
 * apps/api (packages/modules/{intelligence,experiments,content,publishing}). Content packages sit on phase 5's
 * revisions and variants so a variant generated here is the one the calendar schedules. Seeded relative to "now" so
 * every required state is reachable (spec 21.2); `transition*` backdoors stand in for workflows. A test double,
 * never a second implementation.
 */
export const P6 = {
  brandId: 'brd_e2e',
  principalId: 'sp_e2e_analyst',
  campaigns: { spring: 'cmp_spring', missed: 'cmp_missed' },
  briefs: {
    awaiting: 'brf_awaiting',
    suggested: 'brf_suggested',
    incomplete: 'brf_incomplete',
    accepted: 'brf_accepted',
  },
  packages: { review: 'pkg_1', approved: 'pkg_2', changes: 'pkg_4' },
  supersededRevision: 'cr_0',
  experiments: {
    designed: 'exp_designed',
    running: 'exp_running',
    supported: 'exp_supported',
    breach: 'exp_breach',
    inconclusive: 'exp_inconclusive',
  },
  recommendations: { brief: 'rec_brief', test: 'rec_test', playbook: 'rec_playbook' },
  playbook: { approved: 'pbe_approved', proposed: 'pbe_proposed' },
  insights: { change: 'ins_change', gap: 'ins_gap', association: 'ins_assoc', finding: 'ins_finding' },
  /** Provider keys the mock registry has certified; every other key is refused as uncertified (spec 14.6). */
  certifiedProviders: ['linkedin_page', 'linkedin', 'instagram'],
  /** Per-channel caption limits the mock capability check applies when variants are generated. */
  captionLimits: { cc_x: 30 } as Record<string, number>,
};

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const iso = (d: Date) => d.toISOString();
const now = () => iso(new Date());
const hoursAgo = (h: number) => iso(new Date(Date.now() - h * 3_600_000));
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
/** Spec 15.2: stale is older than the expected latency × 2; the weekly analyst makes that a week plus a day. */
const STALE_AFTER_HOURS = 24 * 8;

interface Insight {
  id: string;
  brandId: string;
  kind: 'change' | 'anomaly' | 'association' | 'experimental_finding';
  statement: string;
  evidence: Array<{ kind: string; ref: string; note?: string }>;
  strength: EvidenceStrength;
  periodStart: string;
  periodEnd: string;
  state: 'active';
  agentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Recommendation {
  id: string;
  brandId: string;
  insightIds: string[];
  proposedAction: RecommendationAction;
  title: string;
  rationale: string;
  expectedBenefit: { metricKey: string; direction: 'up' | 'down'; magnitude?: string };
  effort: 'low' | 'medium' | 'high';
  uncertainty: 'low' | 'medium' | 'high';
  rank: number;
  rankingPolicy: 'baseline' | 'learned' | 'exploration';
  state: 'proposed' | 'accepted' | 'dismissed' | 'executed';
  dismissalReason: string | null;
  decidedByUserId: string | null;
  downstreamType: string | null;
  downstreamId: string | null;
  agentRunId: string | null;
  hypothesis: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface PlaybookEntry {
  id: string;
  brandId: string;
  practice: string;
  evidenceIds: string[];
  strength: EvidenceStrength;
  approvedByUserId: string | null;
  reviewAfter: string;
  state: 'proposed' | 'approved' | 'retired';
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface ExperimentVariant {
  id: string;
  label: string;
  contentRevisionId: string;
  allocationWeight: number;
}
interface Experiment {
  id: string;
  brandId: string;
  recommendationId: string | null;
  design: PreRegistrationV1;
  preRegistrationHash: string | null;
  preRegisteredAt: string | null;
  state: 'designed' | 'pre_registered' | 'running' | 'stopped' | 'analysed';
  startedAt: string | null;
  stoppedAt: string | null;
  variants: ExperimentVariant[];
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Result {
  id: string;
  experimentId: string;
  computedAt: string;
  preRegistrationHash: string;
  perVariant: Record<string, { n: number; x: number; rate: number | null; exposure?: number }>;
  estimate: number | null;
  interval: [number, number] | null;
  pValue: number | null;
  guardrailBreached: string[];
  verdict: 'supported' | 'not_supported' | 'inconclusive';
  verdictReason: string;
  methodVersion: string;
}
interface Campaign {
  id: string;
  brandId: string;
  objectiveId: string | null;
  name: string;
  startsAt: string;
  endsAt: string;
  state: 'draft' | 'active' | 'completed' | 'archived';
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Brief {
  id: string;
  brandId: string;
  campaignId: string | null;
  audience: string;
  message: string;
  offerFactIds: string[];
  channelConnectionIds: string[];
  constraints: string[];
  state: 'draft' | 'accepted' | 'in_progress' | 'delivered' | 'cancelled';
  createdByKind: 'user' | 'agent';
  createdById: string;
  agentRunId: string | null;
  recommendationId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Package {
  id: string;
  brandId: string;
  briefId: string | null;
  title: string;
  currentRevisionId: string;
  /** Oldest first. */
  revisionIds: string[];
  state: 'draft' | 'in_review' | 'approved' | 'scheduled' | 'published' | 'archived';
  createdAt: string;
  updatedAt: string;
  version: number;
}

export class Phase6Backend {
  readonly insights = new Map<string, Insight>();
  readonly recommendations = new Map<string, Recommendation>();
  readonly playbook = new Map<string, PlaybookEntry>();
  readonly experiments = new Map<string, Experiment>();
  readonly results = new Map<string, Result[]>();
  readonly campaigns = new Map<string, Campaign>();
  readonly briefs = new Map<string, Brief>();
  readonly packages = new Map<string, Package>();
  readonly connectStates = new Map<string, { brandId: string; providerKey: string }>();
  /** The brand objective (null: ranking refused, spec 16.1). */
  objective: { primaryMetricKey: string; guardrailMetricKeys: string[] } | null = {
    primaryMetricKey: 'qualified_enquiries',
    guardrailMetricKeys: ['complaints'],
  };
  /** An analysis requested through analyst.run that has not written its insights yet. */
  pendingAnalysis: { workflowId: string } | null = null;
  readonly clusters = [
    {
      id: 'vc_1',
      brandId: P6.brandId,
      label: 'Do you ship to Ireland?',
      kind: 'question' as const,
      size: 14,
      sampleMessageRefs: ['msg_1', 'msg_2'],
      linkedRecommendationIds: [P6.recommendations.brief],
      firstSeen: hoursAgo(24 * 20),
      lastSeen: hoursAgo(3),
      version: 1,
    },
  ];
  readonly anomalies = [
    {
      id: 'an_1',
      brandId: P6.brandId,
      signal: 'complaints',
      baseline: 2,
      observed: 9,
      severity: 'high',
      detectedAt: hoursAgo(5),
      state: 'open' as const,
      version: 1,
    },
  ];

  constructor(readonly p5: Phase5Backend) {
    this.seed();
    p5.calendarPackages = (from, to) =>
      [...this.packages.values()]
        .filter((p) => {
          const at = new Date(p.updatedAt).getTime();
          return at >= from && at <= to;
        })
        .map(({ revisionIds: _r, ...p }) => p);
  }

  // ---- backdoors (the workflows' side) ----

  /** The analyst workflow wrote its insights: "What changed" gets newer input and the running state ends. */
  completeAnalysis(): void {
    this.pendingAnalysis = null;
    this.insight('ins_fresh', 'change', 'Saves rose 18% week on week on LinkedIn.', 'observed', 0, [
      { kind: 'metric_key', ref: 'saves' },
    ]);
  }
  /** Another actor edited the stored design after it was frozen: results against it must be rejected. */
  changeDesign(experimentId: string): void {
    const x = this.experiment(experimentId);
    x.design = { ...x.design, hypothesis: `${x.design.hypothesis} (edited)` };
  }
  /** No analysis ever ran: every view is empty. */
  clearAnalysis(): void {
    this.insights.clear();
    this.recommendations.clear();
  }
  /** The newest input is older than the stale threshold. */
  makeStale(): void {
    for (const i of this.insights.values()) {
      i.periodEnd = hoursAgo(STALE_AFTER_HOURS + 48);
      i.periodStart = hoursAgo(STALE_AFTER_HOURS + 48 + 168);
    }
  }
  transitionPackage(packageId: string, revisionState: string): void {
    const pkg = this.pkg(packageId);
    const rev = this.p5.revisions.get(pkg.currentRevisionId);
    if (rev) Object.assign(rev, { state: revisionState, updatedAt: now(), version: rev.version + 1 });
  }

  // ---- reads ----

  pkg(id: string): Package {
    const p = this.packages.get(id);
    if (!p) throw new NotFoundError('ContentPackage', id);
    return p;
  }
  brief(id: string): Brief {
    const b = this.briefs.get(id);
    if (!b) throw new NotFoundError('Brief', id);
    return b;
  }
  experiment(id: string): Experiment {
    const x = this.experiments.get(id);
    if (!x) throw new NotFoundError('Experiment', id);
    return x;
  }

  insightDto(i: Insight) {
    const { updatedAt: _u, ...dto } = i;
    return dto;
  }
  recommendationDto(r: Recommendation) {
    const { hypothesis, ...rest } = r;
    return {
      ...rest,
      actions: r.state === 'proposed' ? [r.proposedAction, 'dismiss' as const] : [],
      learning: {
        id: `lr_${r.id}`,
        recommendationId: r.id,
        contextRef: `brand:${r.brandId}`,
        evidenceRef: r.insightIds.join(','),
        hypothesis,
        action: r.proposedAction,
        humanDecision: null,
        executedRevisionId: null,
        observedOutcomeRef: null,
        verdict: 'pending' as const,
        updatedAt: r.updatedAt,
        version: 1,
      },
    };
  }
  experimentDto(x: Experiment) {
    const d = x.design;
    return {
      id: x.id,
      brandId: x.brandId,
      recommendationId: x.recommendationId,
      hypothesis: d.hypothesis,
      mode: d.mode,
      conclusionLabel: conclusionLabelFor(d.mode),
      primaryMetricKey: d.primaryMetricKey,
      guardrailMetricKeys: d.guardrailMetricKeys,
      allocationMethod: d.allocationMethod,
      minSamplePerArm: d.minSamplePerArm,
      observationWindowHours: d.observationWindowHours,
      variants: x.variants,
      preRegistration: x.preRegistrationHash ? d : null,
      preRegistrationHash: x.preRegistrationHash,
      preRegisteredAt: x.preRegisteredAt,
      state: x.state,
      startedAt: x.startedAt,
      stoppedAt: x.stoppedAt,
      createdByKind: 'user' as const,
      createdById: 'usr_e2e',
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
      version: x.version,
    };
  }
  resultDto(r: Result, mode: ExperimentMode) {
    return { ...r, conclusionLabel: conclusionLabelFor(mode) };
  }

  /** Spec 16.9 workspace, computed the way packages/modules/intelligence builds it. */
  workspace() {
    const at = new Date();
    const freshness = (dates: string[]) => {
      const newest = dates.reduce<string | null>((m, d) => (!m || d > m ? d : m), null);
      if (!newest) return { asOf: null, ageHours: null, stale: false };
      const ageHours = (at.getTime() - new Date(newest).getTime()) / 3_600_000;
      return { asOf: newest, ageHours: Math.round(ageHours * 10) / 10, stale: ageHours > STALE_AFTER_HOURS };
    };
    const all = [...this.insights.values()];
    const changes = all.filter((i) => i.kind === 'change' || i.kind === 'anomaly');
    const associations = all.filter((i) => i.kind === 'association');
    const findings = all.filter((i) => i.kind === 'experimental_finding');
    const proposed = [...this.recommendations.values()].filter((r) => r.state === 'proposed');
    const metricKeys = [
      ...new Set(changes.flatMap((i) => i.evidence.filter((e) => e.kind === 'metric_key').map((e) => e.ref))),
    ];
    const xs = [...this.experiments.values()].map((x) => {
      const latest = this.results.get(x.id)?.at(-1) ?? null;
      return {
        id: x.id,
        hypothesis: x.design.hypothesis,
        mode: x.design.mode,
        conclusionLabel: conclusionLabelFor(x.design.mode),
        state: x.state,
        recommendationId: x.recommendationId,
        startedAt: x.startedAt,
        stoppedAt: x.stoppedAt,
        latestResult: latest
          ? { verdict: latest.verdict, verdictReason: latest.verdictReason, computedAt: latest.computedAt }
          : null,
      };
    });
    const group = (s: string) =>
      s === 'designed' || s === 'pre_registered' ? 'planned' : s === 'running' ? 'running' : 'completed';
    const approved = [...this.playbook.values()].filter((p) => p.state === 'approved');
    const ranked = this.objective !== null && proposed.some((r) => r.rank > 0);
    return {
      brandId: P6.brandId,
      objective: this.objective,
      whatChanged: {
        items: changes.map((i) => this.insightDto(i)),
        coverage: {
          sources: metricKeys,
          competitors: [],
          languages: [],
          periodStart: changes.length ? changes.map((i) => i.periodStart).sort()[0] : iso(at),
          periodEnd: freshness(changes.map((i) => i.periodEnd)).asOf ?? iso(at),
          statement: changes.length
            ? `Metric movements for ${metricKeys.length} metric key(s); missing snapshots are reported as gaps, never as zero`
            : 'No analysis has run for this brand yet',
        },
        freshness: freshness(changes.map((i) => i.periodEnd)),
      },
      whatWeLearned: {
        observations: associations.map((i) => this.insightDto(i)),
        experimentallySupported: findings
          .filter((f) => f.strength === 'experimentally_supported')
          .map((i) => this.insightDto(i)),
        directional: findings
          .filter((f) => f.strength !== 'experimentally_supported')
          .map((i) => this.insightDto(i)),
        statement:
          'Observations and hypotheses are not findings; only experimentally supported entries can support causal claims',
        freshness: freshness([...associations, ...findings].map((i) => i.updatedAt)),
      },
      whatToDoNext: {
        items: (ranked ? [...proposed].sort((a, b) => a.rank - b.rank) : proposed).map((r) =>
          this.recommendationDto(r),
        ),
        ranked,
        rankingPolicy: 'baseline' as const,
        statement: this.objective
          ? `Ranked toward "${this.objective.primaryMetricKey}" with the baseline ranker; effort and uncertainty shown per action`
          : 'No active objective: recommendations are listed unranked until the brand objective is set (spec 16.1)',
        freshness: freshness(proposed.map((r) => r.updatedAt)),
      },
      experiments: {
        planned: xs.filter((x) => group(x.state) === 'planned'),
        running: xs.filter((x) => group(x.state) === 'running'),
        completed: xs.filter(
          (x) => group(x.state) === 'completed' && x.latestResult?.verdict !== 'inconclusive',
        ),
        inconclusive: xs.filter(
          (x) => group(x.state) === 'completed' && x.latestResult?.verdict === 'inconclusive',
        ),
        statement:
          'Structured comparisons are directional, not causal; randomised experiments can support causal claims when design and execution are sound',
        freshness: freshness(
          xs.flatMap((x) =>
            x.latestResult ? [x.latestResult.computedAt] : x.startedAt ? [x.startedAt] : [],
          ),
        ),
      },
      brandPlaybook: {
        items: approved,
        dueForReview: approved.filter((p) => new Date(p.reviewAfter) <= at).map((p) => p.id),
        statement:
          'Approved practices only, each with its evidence, strength and reconsider-by date; standards are never rewritten automatically',
        freshness: freshness(approved.map((p) => p.updatedAt)),
      },
    };
  }

  // ---- seed ----

  private insight(
    id: string,
    kind: Insight['kind'],
    statement: string,
    strength: EvidenceStrength,
    hoursOld: number,
    evidence: Insight['evidence'],
  ) {
    this.insights.set(id, {
      id,
      brandId: P6.brandId,
      kind,
      statement,
      evidence,
      strength,
      periodStart: hoursAgo(hoursOld + 168),
      periodEnd: hoursAgo(hoursOld),
      state: 'active',
      agentRunId: null,
      createdAt: hoursAgo(hoursOld),
      updatedAt: hoursAgo(hoursOld),
      version: 1,
    });
  }
  private recommendation(
    id: string,
    action: RecommendationAction,
    title: string,
    rank: number,
    effort: Recommendation['effort'],
    uncertainty: Recommendation['uncertainty'],
  ) {
    this.recommendations.set(id, {
      id,
      brandId: P6.brandId,
      insightIds: [P6.insights.change, P6.insights.association],
      proposedAction: action,
      title,
      rationale: `Suggested because ${title.toLowerCase()} matches what moved this week.`,
      expectedBenefit: { metricKey: 'qualified_enquiries', direction: 'up', magnitude: 'small' },
      effort,
      uncertainty,
      rank,
      rankingPolicy: 'baseline',
      state: 'proposed',
      dismissalReason: null,
      decidedByUserId: null,
      downstreamType: null,
      downstreamId: null,
      agentRunId: null,
      hypothesis: 'Carousel posts with a price in the first frame draw more enquiries (hypothesis).',
      createdAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      version: 1,
    });
  }
  private design(hypothesis: string, mode: ExperimentMode, revisions: string[]): PreRegistrationV1 {
    return PreRegistrationV1.parse({
      v: 1,
      hypothesis,
      mode,
      variants: revisions.map((r, i) => ({
        label: String.fromCharCode(65 + i),
        contentRevisionId: r,
        allocationWeight: 1,
      })),
      primaryMetricKey: 'qualified_enquiries',
      guardrailMetricKeys: ['complaints'],
      allocationMethod: mode === 'randomised' ? 'hashed_visitor' : 'matched_slots',
      unitType: mode === 'randomised' ? 'visitor' : 'publication_slot',
      minSamplePerArm: 30,
      observationWindowHours: 168,
      stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
    });
  }
  private experimentRow(
    id: string,
    design: PreRegistrationV1,
    state: Experiment['state'],
    startedHoursAgo: number | null,
  ) {
    const frozen = state !== 'designed';
    this.experiments.set(id, {
      id,
      brandId: P6.brandId,
      recommendationId: null,
      design,
      preRegistrationHash: frozen ? hash(design) : null,
      preRegisteredAt: frozen ? hoursAgo((startedHoursAgo ?? 0) + 1) : null,
      state,
      startedAt: startedHoursAgo === null ? null : hoursAgo(startedHoursAgo),
      stoppedAt: state === 'analysed' ? hoursAgo(2) : null,
      variants: design.variants.map((v, i) => ({ id: `${id}_v${i}`, ...v })),
      createdAt: hoursAgo(400),
      updatedAt: hoursAgo(2),
      version: 3,
    });
  }
  private result(
    x: Experiment,
    verdict: Result['verdict'],
    reason: string,
    guardrailBreached: string[] = [],
  ) {
    const [a, b] = x.variants;
    this.results.set(x.id, [
      {
        id: rid('xr'),
        experimentId: x.id,
        computedAt: hoursAgo(2),
        preRegistrationHash: x.preRegistrationHash as string,
        perVariant: {
          [a?.id ?? 'a']: { n: 400, x: 20, rate: 0.05 },
          [b?.id ?? 'b']: { n: 410, x: 33, rate: 0.0805, exposure: 5200 },
        },
        estimate: 0.0305,
        interval: [0.004, 0.057],
        pValue: 0.021,
        guardrailBreached,
        verdict,
        verdictReason: reason,
        methodVersion: 'two-proportion@1',
      },
    ]);
  }

  private seed() {
    this.insight(P6.insights.change, 'change', 'Qualified enquiries fell 12% week on week.', 'observed', 20, [
      { kind: 'metric_key', ref: 'qualified_enquiries' },
    ]);
    this.insight(P6.insights.gap, 'change', 'Instagram reach is missing for 3 of 7 days.', 'observed', 20, [
      { kind: 'metric_key', ref: 'reach' },
      { kind: 'gap', ref: 'cc_instagram', note: 'token expired; unavailable, not zero' },
    ]);
    this.insight(
      P6.insights.association,
      'association',
      'Posts with a price in the first frame were followed by more enquiries.',
      'directional',
      20,
      [{ kind: 'publication', ref: 'pub_published' }],
    );
    this.insight(
      P6.insights.finding,
      'experimental_finding',
      'Landing page B converted better than A for tracked-link visitors.',
      'experimentally_supported',
      30,
      [{ kind: 'experiment', ref: P6.experiments.supported }],
    );
    this.recommendation(
      P6.recommendations.brief,
      'create_brief',
      'Answer the shipping question in a post',
      1,
      'low',
      'medium',
    );
    this.recommendation(
      P6.recommendations.test,
      'prepare_test',
      'Test price-first carousels',
      2,
      'medium',
      'high',
    );
    this.recommendation(
      P6.recommendations.playbook,
      'propose_playbook_update',
      'Lead with the price on offer posts',
      3,
      'low',
      'low',
    );
    this.playbook.set(P6.playbook.approved, {
      id: P6.playbook.approved,
      brandId: P6.brandId,
      practice: 'Reply to product questions within four hours.',
      evidenceIds: [P6.insights.finding],
      strength: 'experimentally_supported',
      approvedByUserId: 'usr_manager',
      reviewAfter: daysFromNow(-1),
      state: 'approved',
      createdAt: hoursAgo(900),
      updatedAt: hoursAgo(50),
      version: 2,
    });
    this.playbook.set(P6.playbook.proposed, {
      id: P6.playbook.proposed,
      brandId: P6.brandId,
      practice: 'Use customer photos on Fridays.',
      evidenceIds: [P6.insights.association],
      strength: 'directional',
      approvedByUserId: null,
      reviewAfter: daysFromNow(90),
      state: 'proposed',
      createdAt: hoursAgo(30),
      updatedAt: hoursAgo(30),
      version: 1,
    });
    const revs = [P5.revisions.one, P5.revisions.two];
    this.experimentRow(
      P6.experiments.designed,
      this.design('Shorter captions lift saves', 'structured_comparison', revs),
      'designed',
      null,
    );
    this.experimentRow(
      P6.experiments.running,
      this.design('Morning slots draw more enquiries', 'structured_comparison', revs),
      'running',
      10,
    );
    this.experimentRow(
      P6.experiments.supported,
      this.design('Landing page B converts better', 'randomised', revs),
      'analysed',
      300,
    );
    this.experimentRow(
      P6.experiments.breach,
      this.design('Discount-first copy lifts enquiries', 'randomised', revs),
      'analysed',
      300,
    );
    this.experimentRow(
      P6.experiments.inconclusive,
      this.design('Emoji in the hook lifts saves', 'structured_comparison', revs),
      'analysed',
      300,
    );
    this.result(
      this.experiment(P6.experiments.supported),
      'supported',
      'Primary metric improved; no guardrail breached',
    );
    this.result(
      this.experiment(P6.experiments.breach),
      'not_supported',
      'Primary metric improved but guardrail complaints breached',
      ['complaints'],
    );
    this.result(this.experiment(P6.experiments.inconclusive), 'inconclusive', 'The interval includes zero');

    this.campaigns.set(P6.campaigns.spring, {
      id: P6.campaigns.spring,
      brandId: P6.brandId,
      objectiveId: null,
      name: 'Spring launch',
      startsAt: daysFromNow(-5),
      endsAt: daysFromNow(25),
      state: 'active',
      createdAt: hoursAgo(200),
      updatedAt: hoursAgo(200),
      version: 1,
    });
    this.campaigns.set(P6.campaigns.missed, {
      id: P6.campaigns.missed,
      brandId: P6.brandId,
      objectiveId: null,
      name: 'Winter clearance',
      startsAt: daysFromNow(-40),
      endsAt: daysFromNow(-3),
      state: 'active',
      createdAt: hoursAgo(1000),
      updatedAt: hoursAgo(1000),
      version: 1,
    });
    const brief = (id: string, over: Partial<Brief>) =>
      this.briefs.set(id, {
        id,
        brandId: P6.brandId,
        campaignId: P6.campaigns.spring,
        audience: 'Homeowners renovating in spring',
        message: 'Our lamps ship free this month',
        offerFactIds: [],
        channelConnectionIds: [P5.channels.ok, P5.channels.two],
        constraints: ['No discount claims without a fact'],
        state: 'draft',
        createdByKind: 'user',
        createdById: 'usr_e2e',
        agentRunId: null,
        recommendationId: null,
        createdAt: hoursAgo(48),
        updatedAt: hoursAgo(48),
        version: 1,
        ...over,
      });
    brief(P6.briefs.awaiting, {});
    brief(P6.briefs.suggested, {
      message: 'Answer the shipping question',
      createdByKind: 'agent',
      createdById: 'sp_e2e_planner',
      agentRunId: 'run_planner',
    });
    brief(P6.briefs.incomplete, { audience: '', message: 'Workshop dates', channelConnectionIds: [] });
    brief(P6.briefs.accepted, { message: 'Autumn offer on lamps', state: 'in_progress' });

    // pkg_1 has revision 2 in review (revision 1 superseded), pkg_4 changes requested, pkg_2 approved.
    const r1 = this.p5.revisions.get(P5.revisions.one);
    if (r1)
      this.p5.revisions.set(P6.supersededRevision, {
        ...r1,
        id: P6.supersededRevision,
        number: 1,
        state: 'superseded',
      });
    if (r1) r1.number = 2;
    const pkg = (id: string, title: string, revisionIds: string[], state: Package['state']) =>
      this.packages.set(id, {
        id,
        brandId: P6.brandId,
        briefId: P6.briefs.accepted,
        title,
        currentRevisionId: revisionIds.at(-1) as string,
        revisionIds,
        state,
        createdAt: hoursAgo(40),
        updatedAt: hoursAgo(2),
        version: revisionIds.length,
      });
    pkg(P6.packages.review, 'Autumn offer post', [P6.supersededRevision, P5.revisions.one], 'in_review');
    pkg(P6.packages.approved, 'Meet the team', [P5.revisions.two], 'approved');
    pkg(P6.packages.changes, 'Workshop dates', [P5.revisions.changes], 'draft');
  }
}

export interface Phase6Builders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

/**
 * The phase 6 routers: top-level ones (intelligence, experiments, content additions) plus the procedures added to
 * phase 5's `content.variants` and `publishing.channels` routers.
 */
export function phase6Routers(b: Phase6Backend, { router, query, mutation }: Phase6Builders) {
  const p5 = b.p5;
  const brandOf = (brandId: string) => {
    if (brandId !== P6.brandId) throw new NotFoundError('Brand', brandId);
  };

  const intelligence = router({
    workspace: router({
      get: query.input(WorkspaceGet).query(({ input }) => {
        brandOf(input.brandId);
        return b.workspace();
      }),
    }),
    anomalies: router({
      list: query.input(AnomalyList).query(({ input }) => {
        brandOf(input.brandId);
        return { items: b.anomalies, nextCursor: null };
      }),
    }),
    voice: router({
      clusters: query.input(VoiceClustersList).query(({ input }) => {
        brandOf(input.brandId);
        return { items: b.clusters };
      }),
    }),
    analyst: router({
      run: mutation.input(AnalystRun).mutation(({ input }) => {
        brandOf(input.brandId);
        const periodEnd = new Date();
        const workflowId = `brand-analyst:${input.brandId}:${iso(periodEnd).slice(0, 10)}`;
        b.pendingAnalysis = { workflowId };
        return {
          brandId: input.brandId,
          workflowId,
          periodStart: iso(new Date(periodEnd.getTime() - input.periodDays * 86_400_000)),
          periodEnd: iso(periodEnd),
        };
      }),
    }),
    recommendations: router({
      accept: mutation.input(RecommendationAccept).mutation(({ input }) => {
        const r = b.recommendations.get(input.recommendationId);
        if (!r) throw new NotFoundError('Recommendation', input.recommendationId);
        if (r.version !== input.expectedVersion)
          throw new ConflictError('Recommendation', r.id, input.expectedVersion);
        if (r.state !== 'proposed')
          throw new ValidationFailedError([
            { path: 'recommendationId', issue: `recommendation is ${r.state}` },
          ]);
        if (input.action !== r.proposedAction)
          throw new ValidationFailedError([{ path: 'action', issue: 'action_not_offered' }]);
        let downstream: { type: string; id: string | null };
        if (input.action === 'create_brief') {
          if (!input.brief)
            throw new ValidationFailedError([{ path: 'brief', issue: 'required for create_brief' }]);
          const id = rid('brf');
          b.briefs.set(id, {
            id,
            brandId: r.brandId,
            campaignId: input.brief.campaignId ?? null,
            audience: input.brief.audience,
            message: input.brief.message,
            offerFactIds: input.brief.offerFactIds,
            channelConnectionIds: input.brief.channelConnectionIds,
            constraints: [],
            state: 'draft',
            createdByKind: 'user',
            createdById: 'usr_e2e',
            agentRunId: null,
            recommendationId: r.id,
            createdAt: now(),
            updatedAt: now(),
            version: 0,
          });
          downstream = { type: 'brief', id };
        } else if (input.action === 'prepare_test') {
          const design = PreRegistrationV1.safeParse(input.experimentDesign);
          if (!design.success)
            throw new ValidationFailedError(
              design.error.issues.map((i) => ({
                path: `experimentDesign.${i.path.join('.')}`,
                issue: i.message,
              })),
            );
          const id = rid('exp');
          b.experiments.set(id, {
            id,
            brandId: r.brandId,
            recommendationId: r.id,
            design: design.data,
            preRegistrationHash: null,
            preRegisteredAt: null,
            state: 'designed',
            startedAt: null,
            stoppedAt: null,
            variants: design.data.variants.map((v, i) => ({ id: `${id}_v${i}`, ...v })),
            createdAt: now(),
            updatedAt: now(),
            version: 0,
          });
          downstream = { type: 'experiment', id };
        } else if (input.action === 'propose_playbook_update') {
          if (!input.playbook)
            throw new ValidationFailedError([
              { path: 'playbook', issue: 'required for propose_playbook_update' },
            ]);
          const id = rid('pbe');
          b.playbook.set(id, {
            id,
            brandId: r.brandId,
            practice: input.playbook.practice,
            evidenceIds: r.insightIds,
            strength: 'observed',
            approvedByUserId: null,
            reviewAfter: input.playbook.reviewAfter,
            state: 'proposed',
            createdAt: now(),
            updatedAt: now(),
            version: 0,
          });
          downstream = { type: 'playbook_entry', id };
        } else if (input.action === 'open_canvas') downstream = { type: 'canvas', id: null };
        else if (input.action === 'generate_variants') {
          if (!input.servicePrincipalId)
            throw new ValidationFailedError([
              { path: 'servicePrincipalId', issue: 'required for generate_variants' },
            ]);
          downstream = { type: 'agent_run', id: rid('run') };
        } else
          throw new ValidationFailedError([
            { path: 'action', issue: 'inbox assignment arrives with the inbox (Release 2)' },
          ]);
        Object.assign(r, {
          state: 'accepted',
          decidedByUserId: 'usr_e2e',
          downstreamType: downstream.type,
          downstreamId: downstream.id,
          updatedAt: now(),
          version: r.version + 1,
        });
        return {
          recommendationId: r.id,
          state: 'accepted' as const,
          action: input.action,
          downstreamType: downstream.type,
          downstreamId: downstream.id,
          version: r.version,
        };
      }),
      dismiss: mutation.input(RecommendationDismiss).mutation(({ input }) => {
        const r = b.recommendations.get(input.recommendationId);
        if (!r) throw new NotFoundError('Recommendation', input.recommendationId);
        if (r.state !== 'proposed')
          throw new ValidationFailedError([
            { path: 'recommendationId', issue: `recommendation is ${r.state}` },
          ]);
        Object.assign(r, {
          state: 'dismissed',
          dismissalReason: input.reason,
          decidedByUserId: 'usr_e2e',
          updatedAt: now(),
          version: r.version + 1,
        });
        return { recommendationId: r.id, state: 'dismissed' as const, version: r.version };
      }),
    }),
    playbook: router({
      list: query.input(PlaybookList).query(({ input }) => {
        brandOf(input.brandId);
        return {
          items: [...b.playbook.values()].filter((p) => !input.state || p.state === input.state),
          nextCursor: null,
        };
      }),
      propose: mutation.input(PlaybookPropose).mutation(({ input }) => {
        brandOf(input.brandId);
        const id = rid('pbe');
        b.playbook.set(id, {
          id,
          brandId: input.brandId,
          practice: input.practice,
          evidenceIds: input.evidenceInsightIds,
          strength: input.strength,
          approvedByUserId: null,
          reviewAfter: input.reviewAfter,
          state: 'proposed',
          createdAt: now(),
          updatedAt: now(),
          version: 0,
        });
        return { playbookEntryId: id, state: 'proposed' as const, version: 0 };
      }),
      approve: mutation.input(PlaybookApprove).mutation(({ input }) => {
        const p = b.playbook.get(input.playbookEntryId);
        if (!p) throw new NotFoundError('PlaybookEntry', input.playbookEntryId);
        if (p.state !== 'proposed')
          throw new ValidationFailedError([{ path: 'playbookEntryId', issue: `entry is ${p.state}` }]);
        Object.assign(p, {
          state: 'approved',
          approvedByUserId: 'usr_e2e',
          updatedAt: now(),
          version: p.version + 1,
        });
        return { playbookEntryId: p.id, state: 'approved' as const, version: p.version };
      }),
    }),
  });

  const experiments = router({
    list: query.input(ExperimentList).query(({ input }) => {
      brandOf(input.brandId);
      return {
        items: [...b.experiments.values()]
          .filter((x) => !input.state || x.state === input.state)
          .sort((a, c) => c.createdAt.localeCompare(a.createdAt))
          .map((x) => b.experimentDto(x)),
        nextCursor: null,
      };
    }),
    get: query.input(ExperimentGet).query(({ input }) => b.experimentDto(b.experiment(input.experimentId))),
    create: mutation.input(ExperimentCreate).mutation(({ input }) => {
      brandOf(input.brandId);
      const d = input.design;
      if (d.mode === 'structured_comparison' && d.allocationMethod === 'hashed_visitor')
        throw new ValidationFailedError([
          {
            path: 'design.allocationMethod',
            issue: 'a structured comparison uses matched slots, not visitors',
          },
        ]);
      const id = rid('exp');
      b.experiments.set(id, {
        id,
        brandId: input.brandId,
        recommendationId: input.recommendationId ?? null,
        design: d,
        preRegistrationHash: null,
        preRegisteredAt: null,
        state: 'designed',
        startedAt: null,
        stoppedAt: null,
        variants: d.variants.map((v, i) => ({ id: `${id}_v${i}`, ...v })),
        createdAt: now(),
        updatedAt: now(),
        version: 0,
      });
      return { experimentId: id, state: 'designed' as const, version: 0 };
    }),
    preRegister: mutation.input(ExperimentPreRegister).mutation(({ input }) => {
      const x = b.experiment(input.experimentId);
      if (x.version !== input.expectedVersion)
        throw new ConflictError('Experiment', x.id, input.expectedVersion);
      if (x.state !== 'designed')
        throw new ValidationFailedError([{ path: 'experimentId', issue: `experiment is ${x.state}` }]);
      Object.assign(x, {
        state: 'pre_registered',
        preRegistrationHash: hash(x.design),
        preRegisteredAt: now(),
        updatedAt: now(),
        version: x.version + 1,
      });
      return {
        experimentId: x.id,
        state: 'pre_registered' as const,
        preRegistrationHash: x.preRegistrationHash as string,
        version: x.version,
      };
    }),
    start: mutation.input(ExperimentStart).mutation(({ input }) => {
      const x = b.experiment(input.experimentId);
      if (x.version !== input.expectedVersion)
        throw new ConflictError('Experiment', x.id, input.expectedVersion);
      Object.assign(x, { state: 'running', startedAt: now(), updatedAt: now(), version: x.version + 1 });
      return { experimentId: x.id, state: 'running' as const, version: x.version };
    }),
    stop: mutation.input(ExperimentStop).mutation(({ input }) => {
      const x = b.experiment(input.experimentId);
      if (x.version !== input.expectedVersion)
        throw new ConflictError('Experiment', x.id, input.expectedVersion);
      Object.assign(x, { state: 'stopped', stoppedAt: now(), updatedAt: now(), version: x.version + 1 });
      return { experimentId: x.id, state: 'stopped' as const, version: x.version };
    }),
    results: router({
      get: query.input(ExperimentResultsGet).query(({ input }) => {
        const x = b.experiment(input.experimentId);
        return {
          experimentId: x.id,
          state: x.state,
          items: (b.results.get(x.id) ?? []).map((r) => b.resultDto(r, x.design.mode)),
        };
      }),
      compute: mutation.input(ExperimentResults).mutation(({ input }) => {
        const x = b.experiment(input.experimentId);
        if (!x.preRegistrationHash || !x.startedAt)
          throw new ValidationFailedError([{ path: 'experimentId', issue: 'not_pre_registered' }]);
        // Both the stated hash and the stored design must still hash to the frozen value (spec 16.6).
        if (input.preRegistrationHash !== x.preRegistrationHash || hash(x.design) !== x.preRegistrationHash)
          throw new ValidationFailedError(
            [{ path: 'preRegistrationHash', issue: 'design_changed' }],
            'Results are computed only against the pre-registered design',
          );
        const windowEnd = new Date(
          new Date(x.startedAt).getTime() + x.design.observationWindowHours * 3_600_000,
        );
        const windowReached = Date.now() >= windowEnd.getTime();
        const sampleReached = x.variants.every(
          (v) => (input.observations.find((o) => o.variantId === v.id)?.n ?? 0) >= x.design.minSamplePerArm,
        );
        if (!(windowReached && sampleReached))
          throw new ValidationFailedError(
            [
              {
                path: 'at',
                issue: windowReached ? 'window_reached' : `window_not_reached_until_${iso(windowEnd)}`,
              },
              {
                path: 'observations',
                issue: sampleReached ? 'sample_reached' : `sample_below_${x.design.minSamplePerArm}_per_arm`,
              },
            ],
            'Results are not declared before the pre-registered sample and window are reached',
          );
        throw new ValidationFailedError([{ path: 'observations', issue: 'the mock does not analyse' }]);
      }),
    }),
  });

  const content = router({
    campaigns: router({
      list: query.input(CampaignList).query(({ input }) => {
        brandOf(input.brandId);
        return { items: [...b.campaigns.values()], nextCursor: null };
      }),
      get: query.input(CampaignGet).query(({ input }) => {
        const c = b.campaigns.get(input.campaignId);
        if (!c) throw new NotFoundError('Campaign', input.campaignId);
        return c;
      }),
      create: mutation.input(CampaignCreate).mutation(({ input }) => {
        brandOf(input.brandId);
        if (new Date(input.endsAt) < new Date(input.startsAt))
          throw new ValidationFailedError([{ path: 'endsAt', issue: 'must not be before startsAt' }]);
        const id = rid('cmp');
        b.campaigns.set(id, {
          id,
          brandId: input.brandId,
          objectiveId: input.objectiveId ?? null,
          name: input.name,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          state: 'draft',
          createdAt: now(),
          updatedAt: now(),
          version: 0,
        });
        return { campaignId: id, state: 'draft' as const, version: 0 };
      }),
    }),
    briefs: router({
      list: query.input(BriefList).query(({ input }) => {
        brandOf(input.brandId);
        return {
          items: [...b.briefs.values()].filter((x) => !input.campaignId || x.campaignId === input.campaignId),
          nextCursor: null,
        };
      }),
      get: query.input(BriefGet).query(({ input }) => b.brief(input.briefId)),
      create: mutation.input(BriefCreate).mutation(({ input }) => {
        brandOf(input.brandId);
        const id = rid('brf');
        b.briefs.set(id, {
          id,
          brandId: input.brandId,
          campaignId: input.campaignId ?? null,
          audience: input.audience,
          message: input.message,
          offerFactIds: input.offerFactIds,
          channelConnectionIds: input.channelConnectionIds,
          constraints: input.constraints,
          state: 'draft',
          createdByKind: 'user',
          createdById: 'usr_e2e',
          agentRunId: null,
          recommendationId: input.recommendationId ?? null,
          createdAt: now(),
          updatedAt: now(),
          version: 0,
        });
        return { briefId: id, state: 'draft' as const, version: 0 };
      }),
      accept: mutation.input(BriefAccept).mutation(({ input }) => {
        const brief = b.brief(input.briefId);
        if (brief.version !== input.expectedVersion)
          throw new ConflictError('Brief', brief.id, input.expectedVersion);
        if (brief.state !== 'draft')
          throw new ValidationFailedError([{ path: 'briefId', issue: `brief is ${brief.state}` }]);
        Object.assign(brief, { state: 'accepted', updatedAt: now(), version: brief.version + 1 });
        return { briefId: brief.id, state: 'accepted' as const, version: brief.version };
      }),
    }),
    packages: router({
      get: query.input(ContentPackageGet).query(({ input }) => {
        const pkg = b.pkg(input.contentPackageId);
        const revision = p5.revisions.get(pkg.currentRevisionId);
        if (!revision) throw new NotFoundError('ContentRevision', pkg.currentRevisionId);
        const { revisionIds, ...dto } = pkg;
        return {
          ...dto,
          revision,
          variants: [...p5.variants.values()].filter((v) => v.contentRevisionId === revision.id),
          revisions: [...revisionIds]
            .reverse()
            .map((id) => p5.revisions.get(id))
            .filter((r) => r !== undefined)
            .map(({ copy: _c, ...summary }) => summary),
        };
      }),
      create: mutation.input(ContentPackageCreate).mutation(({ input }) => {
        brandOf(input.brandId);
        const id = rid('pkg');
        const revisionId = rid('cr');
        const copy = { ...input.copy, master: { ...input.copy.master } };
        p5.revisions.set(revisionId, {
          id: revisionId,
          tenantId: 'ten_e2e',
          brandId: input.brandId,
          contentPackageId: id,
          number: 1,
          brandVersionId: 'bv_e2e',
          policyVersionId: 'pv_e2e',
          copy: { schemaVersion: 1, master: { text: copy.master.text, factRefs: copy.master.factRefs } },
          creativeRevisionIds: input.creativeDocumentIds.map((d) => `rev_of_${d}`),
          factRefs: [],
          contentHash: hash(copy),
          state: 'draft',
          authorKind: 'user',
          authorId: 'usr_e2e',
          agentRunId: null,
          createdAt: now(),
          updatedAt: now(),
          version: 1,
        });
        b.packages.set(id, {
          id,
          brandId: input.brandId,
          briefId: input.briefId ?? null,
          title: input.title,
          currentRevisionId: revisionId,
          revisionIds: [revisionId],
          state: 'draft',
          createdAt: now(),
          updatedAt: now(),
          version: 1,
        });
        if (input.briefId) {
          const brief = b.brief(input.briefId);
          if (brief.state === 'accepted')
            Object.assign(brief, { state: 'in_progress', version: brief.version + 1 });
        }
        return {
          contentPackageId: id,
          contentRevisionId: revisionId,
          number: 1,
          contentHash: hash(copy),
          brandVersionId: 'bv_e2e',
          policyVersionId: 'pv_e2e',
          state: 'draft' as const,
          version: 1,
        };
      }),
      revise: mutation.input(ContentPackageRevise).mutation(({ input }) => {
        const pkg = b.pkg(input.contentPackageId);
        if (pkg.version !== input.expectedVersion)
          throw new ConflictError('ContentPackage', pkg.id, input.expectedVersion);
        const current = p5.revisions.get(pkg.currentRevisionId);
        if (!current) throw new NotFoundError('ContentRevision', pkg.currentRevisionId);
        Object.assign(current, { state: 'superseded', updatedAt: now(), version: current.version + 1 });
        const revisionId = rid('cr');
        p5.revisions.set(revisionId, {
          ...current,
          id: revisionId,
          number: pkg.revisionIds.length + 1,
          copy: {
            schemaVersion: 1,
            master: { text: input.copy.master.text, factRefs: input.copy.master.factRefs },
          },
          contentHash: hash(input.copy),
          state: 'draft',
          createdAt: now(),
          updatedAt: now(),
          version: 1,
        });
        Object.assign(pkg, {
          currentRevisionId: revisionId,
          revisionIds: [...pkg.revisionIds, revisionId],
          state: 'draft',
          updatedAt: now(),
          version: pkg.version + 1,
        });
        return {
          contentPackageId: pkg.id,
          contentRevisionId: revisionId,
          supersededRevisionId: current.id,
          number: pkg.revisionIds.length,
          contentHash: hash(input.copy),
          state: 'draft' as const,
          version: pkg.version,
        };
      }),
    }),
  });

  /** Added to phase 5's `content.variants`: one variant per (revision, channel), existing targets returned as-is. */
  const variants = {
    generate: mutation.input(ChannelVariantGenerate).mutation(({ input }) => {
      const revision = p5.revisions.get(input.contentRevisionId);
      if (!revision) throw new NotFoundError('ContentRevision', input.contentRevisionId);
      const created: string[] = [];
      const out = [];
      for (const channelId of [...new Set(input.channelConnectionIds)]) {
        const existing = [...p5.variants.values()].find(
          (v) => v.contentRevisionId === revision.id && v.channelConnectionId === channelId,
        );
        if (existing) {
          out.push(existing);
          continue;
        }
        const channel = p5.channels.get(channelId);
        if (!channel) throw new NotFoundError('ChannelConnection', channelId);
        const id = rid('cv');
        // A caption over the channel's limit is stored with its finding (spec 14.6), never silently cut.
        const limit = P6.captionLimits[channelId];
        const tooLong = limit !== undefined && revision.copy.master.text.length > limit;
        const variant = {
          id,
          tenantId: 'ten_e2e',
          brandId: revision.brandId,
          contentPackageId: revision.contentPackageId,
          contentRevisionId: revision.id,
          channelConnectionId: channelId,
          text: revision.copy.master.text,
          altTexts: [],
          settings: {},
          exportIds: [],
          exportHashes: [],
          capabilityVersion: channel.capabilityVersion,
          validation: tooLong
            ? {
                ok: false,
                issues: [
                  {
                    path: 'text',
                    issue: `caption is ${revision.copy.master.text.length} characters; the channel allows ${limit}`,
                  },
                ],
              }
            : { ok: true, issues: [] },
          createdAt: now(),
          updatedAt: now(),
          version: 1,
        };
        p5.variants.set(id, variant);
        created.push(id);
        out.push(variant);
      }
      return { contentRevisionId: revision.id, created, variants: out };
    }),
  } satisfies Phase5Extensions['variants'];

  /** Added to phase 5's `publishing.channels`: connect start/complete (spec 14.7) and disconnect. */
  const channels = {
    connect: router({
      start: mutation.input(ChannelConnectStart).mutation(({ input }) => {
        brandOf(input.brandId);
        if (!P6.certifiedProviders.includes(input.providerKey))
          throw new CapabilityUnsupportedError([
            { path: 'providerKey', issue: `provider_not_certified:${input.providerKey}` },
          ]);
        const state = rid('st');
        b.connectStates.set(state, { brandId: input.brandId, providerKey: input.providerKey });
        const url = new URL('https://provider.example/oauth/authorize');
        url.searchParams.set('state', state);
        url.searchParams.set('redirect_uri', input.redirectUri);
        return { state, url: url.toString(), expiresAt: iso(new Date(Date.now() + 600_000)) };
      }),
      complete: mutation.input(ChannelConnectComplete).mutation(({ input }) => {
        const pending = b.connectStates.get(input.state);
        b.connectStates.delete(input.state);
        if (!pending)
          throw new ValidationFailedError(
            [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        // A reconnect of a known remote account rotates the credential of the same connection (spec 14.7).
        const existing = [...p5.channels.values()].find((c) => c.providerKey === pending.providerKey);
        const row: Channel = existing ?? {
          id: rid('cc'),
          brandId: pending.brandId,
          providerKey: pending.providerKey,
          remoteAccountId: 'acct_new',
          displayName: 'Acme LinkedIn Page',
          grantedScopes: ['publish'],
          missingScopes: [],
          status: 'active',
          tokenExpiresAt: daysFromNow(60),
          capabilityVersion: 1,
          usable: true,
          createdAt: now(),
          updatedAt: now(),
          version: 0,
        };
        Object.assign(row, {
          status: 'active',
          usable: true,
          tokenExpiresAt: daysFromNow(60),
          updatedAt: now(),
        });
        row.version += existing ? 1 : 0;
        p5.channels.set(row.id, row);
        return row;
      }),
    }),
    disconnect: mutation.input(ChannelDisconnect).mutation(({ input }) => {
      const c = p5.channels.get(input.channelConnectionId);
      if (!c) throw new NotFoundError('ChannelConnection', input.channelConnectionId);
      if (c.version !== input.expectedVersion)
        throw new ConflictError('ChannelConnection', c.id, input.expectedVersion);
      Object.assign(c, {
        status: 'disabled',
        usable: false,
        tokenExpiresAt: null,
        updatedAt: now(),
        version: c.version + 1,
      });
      const held: string[] = [];
      for (const p of p5.publications.values())
        if (p.channelConnectionId === c.id && p.state === 'scheduled') {
          p5.transition(p.id, {
            state: 'held',
            stateReason: 'channel_disconnected',
            holdReasons: ['channel_active'],
          });
          held.push(p.id);
        }
      return { ...c, heldPublicationIds: held };
    }),
  };

  return { intelligence, experiments, content, variants, channels };
}

/** A policy refusal for a procedure the test marks denied (spec 5.5: the server decides on every call). */
export const deniedError = (path: string) =>
  new PolicyDeniedError('test_denied', `You are not allowed to perform ${path} on this brand`);
