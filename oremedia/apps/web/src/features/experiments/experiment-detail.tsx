import { useState, type FormEvent } from 'react';
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
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { verdictChip } from '../intelligence/intelligence-helpers';
import {
  conclusionText,
  DIRECTIONAL_LABEL,
  estimateText,
  experimentStateChip,
  formatRate,
  isDesignChanged,
  modeLabel,
  resultsRefusalText,
  shortHash,
  windowEnd,
} from './experiment-helpers';
import { useExperiment, useExperimentResults, type ExperimentDto, type ResultDto } from './use-experiments';

export interface ExperimentDetailProps {
  experimentId: string;
}

function ResultView({ result, experiment }: { result: ResultDto; experiment: ExperimentDto }) {
  const verdict = verdictChip(result.verdict);
  const directional = result.conclusionLabel === DIRECTIONAL_LABEL;
  return (
    <div className="flex flex-col gap-2" data-testid="experiment-result" data-verdict={result.verdict}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        <Badge tone={directional ? 'warning' : 'info'} glyph={false} data-testid="conclusion-label">
          {result.conclusionLabel}
        </Badge>
        <span className="text-xs text-muted-foreground">
          computed {new Date(result.computedAt).toLocaleString()} · method {result.methodVersion}
        </span>
      </div>
      <p className="text-sm">{result.verdictReason}</p>
      <p className="text-xs text-muted-foreground">
        {conclusionText(result.conclusionLabel)}. Design hash {shortHash(result.preRegistrationHash)}.
      </p>
      {result.guardrailBreached.length > 0 && (
        <StatusBanner
          tone="critical"
          title={`Guardrail breached: ${result.guardrailBreached.join(', ')}`}
          description="A primary-metric win with a guardrail breach is not supported for the campaign objective (spec 16.6)."
          data-testid="guardrail-breach"
        />
      )}
      <p className="text-sm">
        {estimateText(result.estimate, result.interval)}
        {result.pValue !== null ? ` p = ${result.pValue.toFixed(3)}.` : ''}
      </p>
      <BarSeries
        title="Primary metric rate per variant"
        points={experiment.variants.map((v) => ({
          label: v.label,
          value: result.perVariant[v.id]?.rate ?? null,
        }))}
        format={(v) => formatRate(v)}
      />
      <table className="w-full text-xs">
        <caption className="sr-only">Observations per variant</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="pr-2 font-medium">
              Variant
            </th>
            <th scope="col" className="pr-2 font-medium">
              n
            </th>
            <th scope="col" className="pr-2 font-medium">
              x
            </th>
            <th scope="col" className="font-medium">
              Exposure
            </th>
          </tr>
        </thead>
        <tbody>
          {experiment.variants.map((v) => {
            const o = result.perVariant[v.id];
            return (
              <tr key={v.id}>
                <th scope="row" className="pr-2 text-left font-normal">
                  {v.label}
                </th>
                <td className="pr-2">{o ? o.n : '—'}</td>
                <td className="pr-2">{o ? o.x : '—'}</td>
                <td>{o?.exposure !== undefined ? o.exposure : 'not recorded'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Spec 16.6 results: entered as delivered observations per variant, computed against the frozen design hash. */
function ComputeResultsForm({ experiment }: { experiment: ExperimentDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [rows, setRows] = useState<Record<string, { n: string; x: string }>>(() =>
    Object.fromEntries(experiment.variants.map((v) => [v.id, { n: '', x: '' }])),
  );
  const compute = useMutation(
    trpc.experiments.results.compute.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.experiments.pathFilter());
        void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!experiment.preRegistrationHash) return;
    compute.mutate({
      experimentId: experiment.id,
      preRegistrationHash: experiment.preRegistrationHash,
      observations: experiment.variants.map((v) => ({
        variantId: v.id,
        n: Number(rows[v.id]?.n ?? 0),
        x: Number(rows[v.id]?.x ?? 0),
        guardrails: {},
      })),
    });
  };
  const ui = compute.isError ? toUiError(compute.error) : null;
  const refusal = ui?.kind === 'validation' ? resultsRefusalText(ui.details) : [];
  const set = (id: string, key: 'n' | 'x', value: string) =>
    setRows((r) => ({ ...r, [id]: { ...(r[id] ?? { n: '', x: '' }), [key]: value } }));
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <p className="text-xs text-muted-foreground">
        Delivered observations per variant: units (n) and primary-metric successes (x). Exposure is recorded
        separately by measurement and never assumed equal across arms.
      </p>
      {experiment.variants.map((v) => (
        <fieldset key={v.id} className="grid grid-cols-2 gap-2">
          <legend className="text-xs font-medium">{v.label}</legend>
          <Field label="n" htmlFor={`obs-${v.id}-n`}>
            <Input
              id={`obs-${v.id}-n`}
              type="number"
              min={0}
              value={rows[v.id]?.n ?? ''}
              onChange={(e) => set(v.id, 'n', e.target.value)}
            />
          </Field>
          <Field label="x" htmlFor={`obs-${v.id}-x`}>
            <Input
              id={`obs-${v.id}-x`}
              type="number"
              min={0}
              value={rows[v.id]?.x ?? ''}
              onChange={(e) => set(v.id, 'x', e.target.value)}
            />
          </Field>
        </fieldset>
      ))}
      {ui && ui.kind === 'validation' && isDesignChanged(ui.details) && (
        <StatusBanner
          tone="critical"
          title="Results rejected: the design changed"
          description={
            <>
              {ui.message} Stored hash {shortHash(experiment.preRegistrationHash)}. {refusal.join(' ')}
            </>
          }
          data-testid="design-changed"
        />
      )}
      {ui && ui.kind === 'validation' && !isDesignChanged(ui.details) && (
        <StatusBanner
          tone="warning"
          title="No result yet"
          description={
            <>
              {ui.message}
              {refusal.length ? ` ${refusal.join(' ')}` : ''}
            </>
          }
          data-testid="results-refused"
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Computing results needs experiment.manage for this brand.`}
        />
      )}
      {ui && ui.kind !== 'validation' && ui.kind !== 'forbidden' && (
        <RequestError error={compute.error} title="Results were not computed" />
      )}
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={compute.isPending}>
          {compute.isPending ? 'Computing…' : 'Compute results'}
        </Button>
      </div>
    </form>
  );
}

/** One experiment: frozen design with its hash, lifecycle actions and results with their conclusion label. */
export function ExperimentDetail({ experimentId }: ExperimentDetailProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const experiment = useExperiment(experimentId);
  const results = useExperimentResults(experimentId);
  const preIntent = useIntentKey();
  const startIntent = useIntentKey();
  const stopIntent = useIntentKey();
  const [stopReason, setStopReason] = useState('');
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.experiments.pathFilter());
    void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
  };
  const preRegister = useMutation(
    trpc.experiments.preRegister.mutationOptions({
      ...mutationIntent(preIntent.key),
      onSuccess: () => {
        preIntent.renew();
        invalidate();
      },
    }),
  );
  const start = useMutation(
    trpc.experiments.start.mutationOptions({
      ...mutationIntent(startIntent.key),
      onSuccess: () => {
        startIntent.renew();
        invalidate();
      },
    }),
  );
  const stop = useMutation(
    trpc.experiments.stop.mutationOptions({
      ...mutationIntent(stopIntent.key),
      onSuccess: () => {
        stopIntent.renew();
        invalidate();
      },
    }),
  );
  const x = experiment.data;
  const actionError = [preRegister, start, stop].find((m) => m.isError);
  const actionUi = actionError ? toUiError(actionError.error) : null;

  return (
    <Panel title="Experiment" data-testid="experiment-detail">
      {experiment.isPending && <Skeleton label="Loading experiment" />}
      {experiment.isError && (
        <RequestError error={experiment.error} onRetry={() => void experiment.refetch()} />
      )}
      {x && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={experimentStateChip(x.state).tone} data-testid="experiment-state">
                {experimentStateChip(x.state).label}
              </Badge>
              <Badge tone="neutral" glyph={false}>
                {modeLabel(x.mode)}
              </Badge>
              <Badge tone={x.conclusionLabel === DIRECTIONAL_LABEL ? 'warning' : 'info'} glyph={false}>
                {x.conclusionLabel}
              </Badge>
            </div>
            <p className="text-sm font-medium">{x.hypothesis}</p>
            <p className="text-xs text-muted-foreground">{conclusionText(x.conclusionLabel)}.</p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Primary metric</dt>
            <dd>{x.primaryMetricKey}</dd>
            <dt className="text-muted-foreground">Guardrails</dt>
            <dd>{x.guardrailMetricKeys.length ? x.guardrailMetricKeys.join(', ') : 'none'}</dd>
            <dt className="text-muted-foreground">Allocation</dt>
            <dd>
              {x.allocationMethod.replace(/_/g, ' ')}
              {x.preRegistration ? ` per ${x.preRegistration.unitType.replace(/_/g, ' ')}` : ''}
            </dd>
            <dt className="text-muted-foreground">Minimum sample</dt>
            <dd>{x.minSamplePerArm} per arm</dd>
            <dt className="text-muted-foreground">Window</dt>
            <dd>
              {x.observationWindowHours} h
              {x.startedAt
                ? `, ends ${windowEnd(x.startedAt, x.observationWindowHours).toLocaleString()}`
                : ''}
            </dd>
            <dt className="text-muted-foreground">Stopping rule</dt>
            <dd>
              {x.preRegistration
                ? `${x.preRegistration.stoppingRule.kind.replace(/_/g, ' ')} (alpha ${x.preRegistration.stoppingRule.alpha})`
                : 'frozen at pre-registration'}
            </dd>
            <dt className="text-muted-foreground">Design hash</dt>
            <dd data-testid="design-hash">
              {x.preRegistrationHash ? <code>{x.preRegistrationHash}</code> : 'not frozen yet'}
            </dd>
            <dt className="text-muted-foreground">Variants</dt>
            <dd>
              <ul>
                {x.variants.map((v) => (
                  <li key={v.id}>
                    {v.label}: revision <code>{v.contentRevisionId}</code>, weight {v.allocationWeight}
                  </li>
                ))}
              </ul>
            </dd>
            {x.recommendationId && (
              <>
                <dt className="text-muted-foreground">From recommendation</dt>
                <dd>
                  <code>{x.recommendationId}</code>
                </dd>
              </>
            )}
          </dl>
          {x.preRegisteredAt && (
            <StatusBanner
              tone="info"
              title="Design frozen"
              description={`Pre-registered ${new Date(x.preRegisteredAt).toLocaleString()}; results computed against any other design are rejected.`}
              data-testid="design-frozen"
            />
          )}
          {actionUi && actionUi.kind === 'forbidden' && (
            <StatusBanner
              tone="critical"
              title="Permission denied"
              description={`${actionUi.message} Managing an experiment needs experiment.manage for this brand.`}
              data-testid="experiment-denied"
            />
          )}
          {actionUi && actionUi.kind !== 'forbidden' && actionError && (
            <RequestError error={actionError.error} title="The action was not applied" />
          )}
          <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Experiment actions">
            {x.state === 'designed' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => preRegister.mutate({ experimentId: x.id, expectedVersion: x.version })}
                disabled={preRegister.isPending}
              >
                {preRegister.isPending ? 'Freezing…' : 'Pre-register (freeze design)'}
              </Button>
            )}
            {x.state === 'pre_registered' && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => start.mutate({ experimentId: x.id, expectedVersion: x.version })}
                disabled={start.isPending}
              >
                {start.isPending ? 'Starting…' : 'Start'}
              </Button>
            )}
            {x.state === 'running' && (
              <>
                <Field label="Stop reason (optional)" htmlFor="stop-reason" className="min-w-48 flex-1">
                  <Input
                    id="stop-reason"
                    value={stopReason}
                    onChange={(e) => setStopReason(e.target.value)}
                  />
                </Field>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() =>
                    stop.mutate({
                      experimentId: x.id,
                      expectedVersion: x.version,
                      ...(stopReason.trim() ? { reason: stopReason.trim() } : {}),
                    })
                  }
                  disabled={stop.isPending}
                >
                  {stop.isPending ? 'Stopping…' : 'Stop'}
                </Button>
              </>
            )}
          </div>
          <Panel title="Results" level={3} data-testid="results">
            {results.isPending && <Skeleton label="Loading results" />}
            {results.isError && <RequestError error={results.error} onRetry={() => void results.refetch()} />}
            {results.data && results.data.items.length > 0 && (
              <ResultView result={results.data.items[0] as ResultDto} experiment={x} />
            )}
            {results.data && results.data.items.length === 0 && (
              <EmptyState
                title="No result before the sample and window"
                description={
                  x.startedAt
                    ? `Results are declared only once every arm has ${x.minSamplePerArm} observations and the window ends ${windowEnd(x.startedAt, x.observationWindowHours).toLocaleString()}${x.preRegistration?.stoppingRule.kind === 'sequential_msprt' ? ', or earlier under the pre-registered sequential rule' : ''}.`
                    : 'The experiment has not started; pre-register the design, then start it.'
                }
              />
            )}
            {(x.state === 'running' || x.state === 'stopped') && x.preRegistrationHash && (
              <div className="mt-3 border-t border-border pt-3">
                <ComputeResultsForm key={x.version} experiment={x} />
              </div>
            )}
          </Panel>
        </div>
      )}
    </Panel>
  );
}
