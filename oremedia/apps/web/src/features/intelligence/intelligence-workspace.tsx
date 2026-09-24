import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BarSeries,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  Skeleton,
  StatusBanner,
} from '@oremedia/ui';
import { PageHeading, RequestError } from '../../components/request-state';
import { Tab, TabList, TabPanel, Tabs } from '../../components/tabs';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useCompanies } from '../portfolio/use-companies';
import { FreshnessLine } from './freshness-line';
import {
  canApprovePlaybook,
  clusterKindChip,
  EXPERIMENT_GROUP_LABEL,
  hasCoverageGaps,
  insightLabel,
  severityChip,
  STRENGTH_CHIP,
  verdictChip,
} from './intelligence-helpers';
import { PlaybookPanel } from './playbook-panel';
import { RecommendationCard } from './recommendation-card';
import {
  useAnomalies,
  useVoiceClusters,
  useWorkspace,
  type AnalystRunDto,
  type InsightDto,
  type RecommendationDto,
  type WorkspaceDto,
  type WorkspaceExperimentDto,
} from './use-intelligence';

const VIEW_PARAM = 'view';
const VIEWS = ['changed', 'learned', 'next', 'experiments', 'playbook'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  changed: 'What changed',
  learned: 'What we learned',
  next: 'What to do next',
  experiments: 'Experiments',
  playbook: 'Brand playbook',
};

function InsightList({ items, label, emptyText }: { items: InsightDto[]; label: string; emptyText: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y divide-border" aria-label={label}>
      {items.map((i) => {
        const strength = STRENGTH_CHIP[i.strength];
        return (
          <li
            key={i.id}
            className="flex flex-col gap-1 py-2"
            data-testid="insight"
            data-insight-kind={i.kind}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={strength.tone} glyph={false}>
                {insightLabel(i.kind, i.strength)}
              </Badge>
              <Badge tone={strength.tone}>{strength.label}</Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(i.periodStart).toLocaleDateString()} to {new Date(i.periodEnd).toLocaleDateString()}
              </span>
            </div>
            <p className="text-sm">{i.statement}</p>
            {i.evidence.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Evidence:{' '}
                {i.evidence.map((e) => `${e.kind} ${e.ref}${e.note ? ` (${e.note})` : ''}`).join('; ')}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ExperimentGroup({
  label,
  items,
  companyId,
  brandId,
}: {
  label: string;
  items: WorkspaceExperimentDto[];
  companyId: string;
  brandId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">
        {label} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((x) => {
            const verdict = x.latestResult ? verdictChip(x.latestResult.verdict) : null;
            return (
              <li key={x.id} className="py-2 text-sm">
                <Link
                  to={brandPath(companyId, brandId, `experiments?experiment=${encodeURIComponent(x.id)}`)}
                  className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {x.hypothesis}
                </Link>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge tone="neutral" glyph={false}>
                    {x.mode.replace(/_/g, ' ')}
                  </Badge>
                  <span>{x.conclusionLabel}</span>
                  {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
                  {x.latestResult && <span>{x.latestResult.verdictReason}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The ranked list. A decided recommendation leaves the workspace's proposed list on the next read; the card is kept
 * (same key, same list) under "Decided just now" so its outcome and the link to what it created stay visible.
 */
function RecommendationList({
  companyId,
  brandId,
  view,
}: {
  companyId: string;
  brandId: string;
  view: WorkspaceDto['whatToDoNext'];
}) {
  const [decided, setDecided] = useState<RecommendationDto[]>([]);
  const current = new Set(view.items.map((r) => r.id));
  const retained = decided.filter((r) => !current.has(r.id));
  const remember = (r: RecommendationDto) => setDecided((d) => [...d.filter((x) => x.id !== r.id), r]);
  const rows = [
    ...view.items.map((r, i) => ({ r, position: view.ranked ? i + 1 : null })),
    ...retained.map((r) => ({ r, position: null })),
  ];
  if (view.items.length === 0 && retained.length === 0)
    return (
      <EmptyState
        title="No recommendations"
        description="The analyst has not proposed anything for this period, or every recommendation was decided."
      />
    );
  return (
    <>
      {view.items.length === 0 && (
        <p className="mb-2 text-sm text-muted-foreground">No recommendations are waiting for a decision.</p>
      )}
      <ul className="flex flex-col gap-3" aria-label="Recommendations">
        {/* One keyed array: a card moving from waiting to decided keeps its state (and its outcome banner). */}
        {rows.map(({ r, position }) => (
          <RecommendationCard
            key={r.id}
            companyId={companyId}
            brandId={brandId}
            recommendation={r}
            position={position}
            onDecided={remember}
          />
        ))}
      </ul>
    </>
  );
}

interface Analysis {
  run: AnalystRunDto;
  /** The "What changed" freshness before the run: the output has arrived once this changes. */
  asOfBefore: string | null;
}

/** Spec 16.3 on demand: the person names the analyst principal; the workflow writes insights when it completes. */
function AnalyseNowForm({
  brandId,
  onStarted,
}: {
  brandId: string;
  onStarted: (run: AnalystRunDto) => void;
}) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const [principalId, setPrincipalId] = useState('');
  const [periodDays, setPeriodDays] = useState('7');
  const run = useMutation(
    trpc.intelligence.analyst.run.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        onStarted(res);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(periodDays);
    if (!principalId.trim() || !Number.isInteger(days) || days < 1) return;
    run.mutate({ brandId, servicePrincipalId: principalId.trim(), periodDays: days });
  };
  const ui = run.isError ? toUiError(run.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field
          label="Analyst principal"
          htmlFor="analyse-principal"
          hint="sp_… of the performance-review agent principal."
          error={ui?.details.find((d) => d.path === 'servicePrincipalId')?.issue}
        >
          <Input
            id="analyse-principal"
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <Field label="Period (days)" htmlFor="analyse-days">
          <Input
            id="analyse-days"
            type="number"
            min={1}
            max={90}
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            className="w-24"
          />
        </Field>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Running the analyst needs insight.manage for this brand and the brand analyst enabled for the company.`}
          data-testid="analyse-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && <RequestError error={run.error} title="The analysis did not start" />}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={run.isPending || !principalId.trim()}
          disabledReason={principalId.trim() ? undefined : 'Enter the analyst principal id first'}
        >
          {run.isPending ? 'Starting…' : 'Analyse now'}
        </Button>
      </div>
    </form>
  );
}

function WhatChanged({ view, brandId }: { view: WorkspaceDto['whatChanged']; brandId: string }) {
  const anomalies = useAnomalies(brandId);
  const gaps = hasCoverageGaps(view.items);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Movements and data gaps" data-testid="what-changed">
        <FreshnessLine
          freshness={view.freshness}
          coverage={view.coverage}
          statement={view.coverage.statement}
        />
        {gaps && (
          <StatusBanner
            tone="warning"
            title="Coverage is partial"
            description="Some snapshots are missing for the period; they are reported as gaps below, never counted as zero."
            data-testid="coverage-partial"
          />
        )}
        {view.items.length === 0 ? (
          <EmptyState
            title="No data yet"
            description="No analysis has run for this brand. Run the analyst once metric snapshots exist; until then nothing is shown and nothing is estimated."
          />
        ) : (
          <InsightList items={view.items} label="Movements" emptyText="" />
        )}
      </Panel>
      <Panel title="Anomalies" data-testid="anomalies">
        {anomalies.isPending && <Skeleton label="Loading anomalies" />}
        {anomalies.isError && (
          <RequestError error={anomalies.error} onRetry={() => void anomalies.refetch()} />
        )}
        {anomalies.data && anomalies.data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">No anomalies recorded.</p>
        )}
        {anomalies.data && anomalies.data.items.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Anomalies">
            {anomalies.data.items.map((a) => {
              const sev = severityChip(a.severity);
              return (
                <li key={a.id} className="flex flex-col gap-1 py-2" data-testid="anomaly">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={sev.tone}>{sev.label}</Badge>
                    <span className="font-medium">{a.signal}</span>
                    <Badge tone="neutral" glyph={false}>
                      {a.state}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      detected {new Date(a.detectedAt).toLocaleString()}
                    </span>
                  </div>
                  <BarSeries
                    title={`${a.signal}: baseline versus observed`}
                    points={[
                      { label: 'baseline', value: a.baseline },
                      { label: 'observed', value: a.observed },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function WhatWeLearned({ view, brandId }: { view: WorkspaceDto['whatWeLearned']; brandId: string }) {
  const clusters = useVoiceClusters(brandId);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Observations and hypotheses" data-testid="what-we-learned">
        <FreshnessLine freshness={view.freshness} statement={view.statement} />
        <InsightList
          items={[...view.observations, ...view.directional]}
          label="Hypotheses"
          emptyText="No observations or hypotheses yet."
        />
      </Panel>
      <Panel title="Experimentally supported findings" data-testid="findings">
        <InsightList
          items={view.experimentallySupported}
          label="Findings"
          emptyText="No experimentally supported findings yet. Only a sound randomised experiment can add one."
        />
      </Panel>
      <Panel title="Customer voice" data-testid="voice">
        <p className="mb-2 text-xs text-muted-foreground">
          Clusters of comments by kind with counts and sample references; author identities are never shown
          here. Social discussion is not a representative measure of market demand.
        </p>
        {clusters.isPending && <Skeleton label="Loading customer voice" />}
        {clusters.isError && <RequestError error={clusters.error} onRetry={() => void clusters.refetch()} />}
        {clusters.data && clusters.data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">No clusters yet.</p>
        )}
        {clusters.data && clusters.data.items.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Customer voice clusters">
            {clusters.data.items.map((c) => {
              const kind = clusterKindChip(c.kind);
              return (
                <li key={c.id} className="flex flex-col gap-1 py-2" data-testid="cluster">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={kind.tone}>{kind.label}</Badge>
                    <span className="font-medium">{c.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.size} message{c.size === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    First seen {new Date(c.firstSeen).toLocaleDateString()} · last seen{' '}
                    {new Date(c.lastSeen).toLocaleString()} · samples {c.sampleMessageRefs.length}
                    {c.linkedRecommendationIds.length
                      ? ` · linked recommendations ${c.linkedRecommendationIds.join(', ')}`
                      : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/** Spec 21.1 `intelligence/`: the five views of spec 16.9 as tabs; the selected view is in the URL. */
export function IntelligenceWorkspaceScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get(VIEW_PARAM);
  const view: View = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as View) : 'changed';
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const workspace = useWorkspace(brandId, analysis !== null);
  const companies = useCompanies();
  const role = companies.data?.find((c) => c.tenantId === companyId)?.role ?? null;
  const ws = workspace.data;
  const asOf = ws?.whatChanged.freshness.asOf;
  const analysing = analysis !== null && ws !== undefined && asOf === analysis.asOfBefore;
  // The run is over for this screen once the "What changed" view carries newer input than before it started.
  useEffect(() => {
    if (analysis !== null && ws !== undefined && asOf !== analysis.asOfBefore) setAnalysis(null);
  }, [analysis, ws, asOf]);
  const systemHref = brandPath(companyId, brandId, 'system');

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <PageHeading
        title="Intelligence"
        description={`What changed, what ${brand.name} learned and what to do next. Every number carries its fetch time; hypotheses are labelled as such and only experiments support causal claims.`}
        actions={
          <Button
            size="sm"
            onClick={() => void queryClient.invalidateQueries(trpc.intelligence.pathFilter())}
            disabled={workspace.isFetching}
          >
            {workspace.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      {workspace.isPending && <Skeleton label="Loading intelligence workspace" lines={4} />}
      {workspace.isError && (
        <RequestError
          error={workspace.error}
          onRetry={() => void workspace.refetch()}
          title={toUiError(workspace.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {ws && (
        <>
          {ws.objective === null && (
            <StatusBanner
              tone="warning"
              title="No objective set: recommendations are not ranked"
              description={ws.whatToDoNext.statement}
              actions={
                <Button size="sm" asChild>
                  <Link to={systemHref}>Set an objective</Link>
                </Button>
              }
              data-testid="no-objective"
            />
          )}
          {analysing && analysis && (
            <StatusBanner
              tone="info"
              busy
              title="Analysis running"
              description={`Workflow ${analysis.run.workflowId} reviews ${new Date(analysis.run.periodStart).toLocaleDateString()} to ${new Date(analysis.run.periodEnd).toLocaleDateString()}. The views refresh when its insights land.`}
              data-testid="analysis-running"
            />
          )}
          <Panel title="Analyse now" id="analyse-now">
            <AnalyseNowForm
              brandId={brandId}
              onStarted={(run) => setAnalysis({ run, asOfBefore: ws.whatChanged.freshness.asOf })}
            />
          </Panel>
          <Tabs
            value={view}
            onValueChange={(v) => setParams({ [VIEW_PARAM]: v }, { replace: true })}
            className="flex flex-col gap-4"
          >
            <TabList label="Intelligence views" className="overflow-x-auto">
              {VIEWS.map((v) => (
                <Tab key={v} value={v}>
                  {VIEW_LABEL[v]}
                </Tab>
              ))}
            </TabList>
            <TabPanel value="changed">
              <WhatChanged view={ws.whatChanged} brandId={brandId} />
            </TabPanel>
            <TabPanel value="learned">
              <WhatWeLearned view={ws.whatWeLearned} brandId={brandId} />
            </TabPanel>
            <TabPanel value="next">
              <Panel title="Ranked actions" data-testid="what-to-do-next">
                <FreshnessLine freshness={ws.whatToDoNext.freshness} statement={ws.whatToDoNext.statement} />
                <p className="mb-2 text-xs text-muted-foreground">
                  {ws.whatToDoNext.ranked
                    ? `Ranking policy: ${ws.whatToDoNext.rankingPolicy}.`
                    : 'Unranked list.'}
                </p>
                <RecommendationList companyId={companyId} brandId={brandId} view={ws.whatToDoNext} />
              </Panel>
            </TabPanel>
            <TabPanel value="experiments">
              <Panel
                title="Experiments"
                data-testid="experiments-view"
                actions={
                  <Button size="sm" asChild>
                    <Link to={brandPath(companyId, brandId, 'experiments')}>Open experiments</Link>
                  </Button>
                }
              >
                <FreshnessLine freshness={ws.experiments.freshness} statement={ws.experiments.statement} />
                <div className="flex flex-col gap-3">
                  {(Object.keys(EXPERIMENT_GROUP_LABEL) as Array<keyof typeof EXPERIMENT_GROUP_LABEL>).map(
                    (g) => (
                      <ExperimentGroup
                        key={g}
                        label={EXPERIMENT_GROUP_LABEL[g]}
                        items={ws.experiments[g]}
                        companyId={companyId}
                        brandId={brandId}
                      />
                    ),
                  )}
                </div>
              </Panel>
            </TabPanel>
            <TabPanel value="playbook">
              <PlaybookPanel
                brandId={brandId}
                view={ws.brandPlaybook}
                insights={[
                  ...ws.whatChanged.items,
                  ...ws.whatWeLearned.observations,
                  ...ws.whatWeLearned.directional,
                  ...ws.whatWeLearned.experimentallySupported,
                ]}
                canApprove={canApprovePlaybook(role)}
              />
            </TabPanel>
          </Tabs>
        </>
      )}
    </main>
  );
}
