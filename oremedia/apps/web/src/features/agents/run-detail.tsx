import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Panel, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { useToast } from '../../components/toast';
import { brandPath } from '../brand/brand-context';
import { toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { JsonTree } from './json-tree';
import {
  OUTCOME_TONE,
  POLICY_DECISION_TONE,
  STEP_KIND_LABEL,
  formatDuration,
  formatMicros,
  formatTokens,
  isTerminalState,
  modifyBatchOf,
  needsAttention,
  pendingProposal,
  runStateChip,
  type PendingProposal,
} from './run-helpers';
import { useAgentRun, useAgentRunSteps, type RunDto, type StepDto } from './use-agent-runs';

export interface RunDetailProps {
  companyId: string;
  brandId: string;
  runId: string;
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

/** Run detail: state, needs-attention, the pending proposal and the step timeline (spec 12.7: never reasoning). */
export function RunDetail({ companyId, brandId, runId }: RunDetailProps) {
  const run = useAgentRun(runId);
  const live = run.data ? !isTerminalState(run.data.state) : false;
  const steps = useAgentRunSteps(runId, live);
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    headingRef.current?.focus(); // managed focus: selecting a run moves focus to its detail (spec 21.3)
  }, [runId]);

  if (run.isPending)
    return (
      <Panel title="Run" data-testid="run-detail">
        <Skeleton label="Loading run" lines={4} />
      </Panel>
    );
  if (run.isError)
    return (
      <Panel title="Run" data-testid="run-detail">
        <RequestError
          error={run.error}
          onRetry={() => void run.refetch()}
          title={
            toUiError(run.error).kind === 'forbidden'
              ? 'Restricted: this run is not in a brand you can see'
              : undefined
          }
        />
      </Panel>
    );
  const chip = runStateChip(run.data.state);
  const items = steps.data?.items ?? [];
  const attention = needsAttention(run.data, items);
  const proposal = run.data.state === 'waiting_for_review' ? pendingProposal(items) : null;
  return (
    <Panel
      title={`Run ${run.data.id}`}
      data-testid="run-detail"
      data-run-state={run.data.state}
      actions={<CancelRun run={run.data} />}
    >
      <div
        ref={headingRef}
        tabIndex={-1}
        className="flex flex-col gap-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={chip.tone} data-testid="run-state">
            {chip.label}
          </Badge>
          <span className="font-medium">{run.data.taskKind.replace(/_/g, ' ')}</span>
          <Badge glyph={false}>{run.data.autonomyMode}</Badge>
          {live && <span className="text-xs text-muted-foreground">Refreshing every 5 s</span>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Initiator</dt>
          <dd>
            {run.data.initiatorKind} <code>{run.data.initiatorId}</code>
          </dd>
          <dt className="text-muted-foreground">Service principal</dt>
          <dd>
            <code>{run.data.servicePrincipalId}</code>
          </dd>
          <dt className="text-muted-foreground">Cost</dt>
          <dd data-testid="run-cost">{formatMicros(run.data.costMicros)}</dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{when(run.data.createdAt)}</dd>
          <dt className="text-muted-foreground">Finished</dt>
          <dd>{when(run.data.finishedAt)}</dd>
          <dt className="text-muted-foreground">Deadline</dt>
          <dd>{when(run.data.deadlineAt)}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd>
            {run.data.modelConfig['provider']} / {run.data.modelConfig['model']}
          </dd>
          <dt className="text-muted-foreground">Correlation</dt>
          <dd>
            <code>{run.data.correlationId}</code>
          </dd>
        </dl>
        {attention.length > 0 && (
          <section aria-label="Needs attention" data-testid="needs-attention" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Needs attention</h3>
            {attention.map((a, i) => (
              <StatusBanner key={i} tone={a.tone} title={a.title} description={a.detail} live="polite" />
            ))}
          </section>
        )}
        {run.data.state === 'waiting_for_review' && steps.isSuccess && !proposal && (
          <StatusBanner
            tone="warning"
            title="Proposal not found"
            description="The run is waiting for review but no proposal invocation is recorded yet; it refreshes automatically."
          />
        )}
        {proposal && (
          <ProposalDecision companyId={companyId} brandId={brandId} run={run.data} proposal={proposal} />
        )}
        <section aria-label="Timeline" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Timeline</h3>
          {steps.isPending && <Skeleton label="Loading steps" lines={3} />}
          {steps.isError && <RequestError error={steps.error} onRetry={() => void steps.refetch()} />}
          {steps.isSuccess && items.length === 0 && (
            <EmptyState
              title="No steps recorded yet"
              description={
                live
                  ? 'The run has not reached its first step; this list refreshes automatically.'
                  : 'The run ended before any step was recorded.'
              }
            />
          )}
          {steps.isSuccess && items.length > 0 && <Timeline steps={items} />}
        </section>
      </div>
    </Panel>
  );
}

function Timeline({ steps }: { steps: StepDto[] }) {
  return (
    <ol className="flex flex-col gap-2" aria-label="Steps" data-testid="timeline">
      {steps.map((s) => (
        <li
          key={s.id}
          className="rounded-md border border-border p-2 text-sm"
          data-testid="step"
          data-step-kind={s.kind}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{s.index}</span>
            <Badge glyph={false}>{STEP_KIND_LABEL[s.kind]}</Badge>
            <span className="min-w-0 flex-1 break-words">{s.summary}</span>
          </div>
          <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <div>
              <dt className="inline">Tokens </dt>
              <dd className="inline">
                {formatTokens(s.tokensIn)} in / {formatTokens(s.tokensOut)} out
              </dd>
            </div>
            <div>
              <dt className="inline">Cost </dt>
              <dd className="inline">{formatMicros(s.costMicros)}</dd>
            </div>
            <div>
              <dt className="inline">Duration </dt>
              <dd className="inline">{formatDuration(s.durationMs)}</dd>
            </div>
            <div>
              <dt className="inline">At </dt>
              <dd className="inline">{when(s.createdAt)}</dd>
            </div>
          </dl>
          {s.invocations.length > 0 && (
            <ul className="mt-2 flex flex-col gap-2" aria-label="Tool invocations">
              {s.invocations.map((i) => (
                <li
                  key={i.id}
                  className="rounded-md bg-muted p-2"
                  data-testid="invocation"
                  data-policy-decision={i.policyDecision}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-semibold">{i.toolName}</code>
                    <Badge tone={POLICY_DECISION_TONE[i.policyDecision]}>policy {i.policyDecision}</Badge>
                    {i.policyReason && <span className="text-xs">{i.policyReason}</span>}
                    <Badge tone={OUTCOME_TONE[i.outcome]}>outcome {i.outcome}</Badge>
                    {i.outputRef && (
                      <span className="text-xs text-muted-foreground">
                        output <code>{i.outputRef}</code>
                      </span>
                    )}
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer rounded-sm text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Redacted input (hash {i.inputHash.slice(0, 12)}…)
                    </summary>
                    <div className="mt-1">
                      <JsonTree value={i.inputRedacted} label={`Redacted input of ${i.toolName}`} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Spec 13.5: cancel moves the row and signals the workflow; the person confirms first. */
function CancelRun({ run }: { run: RunDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const intent = useIntentKey();
  const cancel = useMutation(
    trpc.agents.runs.cancel.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.agents.pathFilter());
        toast({ tone: 'neutral', title: 'Run cancelled' });
      },
    }),
  );
  if (isTerminalState(run.state)) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        Cancel run
      </Button>
      <DialogContent
        role="alertdialog"
        title="Cancel this run?"
        description="The run stops at its next checkpoint, its budget reservation is released and any pending proposal is dropped. This cannot be undone."
      >
        {cancel.isError && <RequestError error={cancel.error} className="mb-2" />}
        <DialogActions>
          <DialogClose asChild>
            <Button>Keep running</Button>
          </DialogClose>
          <Button
            variant="danger"
            onClick={() => cancel.mutate({ runId: run.id })}
            disabled={cancel.isPending}
            data-testid="confirm-cancel"
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Spec 12.2 proposalDecision through agents.runs.approveProposal: Accept applies the batch as the run's principal,
 * Reject sends the model back, Modify applies the person's own batch (edited here as JSON; the studio shows the
 * document it targets).
 */
function ProposalDecision({
  companyId,
  brandId,
  run,
  proposal,
}: {
  companyId: string;
  brandId: string;
  run: RunDto;
  proposal: PendingProposal;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const intent = useIntentKey();
  const [modifying, setModifying] = useState(false);
  const [batchText, setBatchText] = useState(() => modifyBatchOf(proposal.payload));
  const [batchError, setBatchError] = useState<string | null>(null);
  const decide = useMutation(
    trpc.agents.runs.approveProposal.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setModifying(false);
        void queryClient.invalidateQueries(trpc.agents.pathFilter());
        toast({
          tone: 'good',
          title: `Proposal ${res.decision === 'accept' ? 'accepted' : res.decision === 'reject' ? 'rejected' : 'modified'}`,
          description: res.appliedRevisionId ? `Applied as revision ${res.appliedRevisionId}.` : undefined,
        });
      },
    }),
  );
  const submitModify = () => {
    let batch: unknown;
    try {
      batch = JSON.parse(batchText);
    } catch (err) {
      setBatchError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setBatchError(null);
    decide.mutate({ runId: run.id, stepId: proposal.stepId, decision: 'modify', batch });
  };
  const blocking = proposal.payload.findings.filter((f) => f.severity === 'blocking');
  return (
    <section aria-label="Proposal" data-testid="proposal" className="flex flex-col gap-3">
      <StatusBanner
        tone={blocking.length > 0 ? 'critical' : 'warning'}
        title="Agent proposal pending"
        description={proposal.payload.summary || `${proposal.payload.operations.length} operation(s)`}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Document</dt>
        <dd>
          <Link
            to={brandPath(companyId, brandId, `studio/${encodeURIComponent(proposal.payload.documentId)}`)}
            className="underline"
          >
            Open <code>{proposal.payload.documentId}</code> in the studio
          </Link>
        </dd>
        <dt className="text-muted-foreground">Base revision</dt>
        <dd>
          <code>{proposal.payload.baseRevisionId}</code>
        </dd>
        <dt className="text-muted-foreground">Operations</dt>
        <dd>{proposal.payload.operations.length}</dd>
      </dl>
      {proposal.payload.findings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Findings">
          {proposal.payload.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge
                tone={f.severity === 'blocking' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info'}
              >
                {f.severity}
              </Badge>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer rounded-sm text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Proposed operations
        </summary>
        <div className="mt-1">
          <JsonTree value={proposal.payload.operations} label="Proposed operations" />
        </div>
      </details>
      {decide.isError && <RequestError error={decide.error} title="Decision not recorded" />}
      {!modifying && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={decide.isPending}
            disabledReason={
              blocking.length > 0
                ? `Blocked by ${blocking.length} finding${blocking.length === 1 ? '' : 's'}; modify it or reject`
                : undefined
            }
            onClick={() => decide.mutate({ runId: run.id, stepId: proposal.stepId, decision: 'accept' })}
          >
            Accept
          </Button>
          <Button size="sm" disabled={decide.isPending} onClick={() => setModifying(true)}>
            Modify
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ runId: run.id, stepId: proposal.stepId, decision: 'reject' })}
          >
            Reject
          </Button>
        </div>
      )}
      {modifying && (
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submitModify();
          }}
        >
          <Field
            label="Batch to apply instead (JSON)"
            htmlFor="modify-batch"
            hint="documentId must match the proposal; origin is set to you by the server. Validated by the creative module."
            error={batchError ?? undefined}
          >
            <Textarea
              id="modify-batch"
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              rows={12}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={decide.isPending}>
              {decide.isPending ? 'Applying…' : 'Apply modified batch'}
            </Button>
            <Button type="button" size="sm" onClick={() => setModifying(false)}>
              Back
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
