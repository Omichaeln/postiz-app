import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EvidenceStrength } from '@oremedia/contracts/intelligence';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  Skeleton,
  StatusBanner,
  Textarea,
} from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { localInputToIso, isoToLocalInput } from '../publishing/publication-state';
import { FreshnessLine } from './freshness-line';
import { defaultReviewAfter, playbookStateChip, STRENGTH_CHIP } from './intelligence-helpers';
import type { InsightDto, PlaybookEntryDto, WorkspaceDto } from './use-intelligence';
import { useProposedPlaybook } from './use-intelligence';

export interface PlaybookPanelProps {
  brandId: string;
  view: WorkspaceDto['brandPlaybook'];
  /** Insights the person can cite as evidence for a proposal. */
  insights: InsightDto[];
  canApprove: boolean;
}

function EntryRow({
  entry,
  dueForReview,
  canApprove,
}: {
  entry: PlaybookEntryDto;
  dueForReview: boolean;
  canApprove: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const approve = useMutation(
    trpc.intelligence.playbook.approve.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
      },
    }),
  );
  const chip = playbookStateChip(approve.data?.state ?? entry.state);
  const strength = STRENGTH_CHIP[entry.strength];
  const ui = approve.isError ? toUiError(approve.error) : null;
  return (
    <li
      className="flex flex-col gap-1 py-2"
      data-testid="playbook-entry"
      data-playbook-state={chip.label.toLowerCase()}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={chip.tone}>{chip.label}</Badge>
        <Badge tone={strength.tone}>{strength.label}</Badge>
        {dueForReview && <Badge tone="warning">Due for review</Badge>}
      </div>
      <p className="text-sm">{entry.practice}</p>
      <p className="text-xs text-muted-foreground">
        Evidence: {entry.evidenceIds.length ? entry.evidenceIds.join(', ') : 'none recorded'} · reconsider by{' '}
        {new Date(entry.reviewAfter).toLocaleDateString()}
        {entry.approvedByUserId ? ` · approved by ${entry.approvedByUserId}` : ''}
      </p>
      {entry.state === 'proposed' && !approve.data && canApprove && (
        <div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => approve.mutate({ playbookEntryId: entry.id, expectedVersion: entry.version })}
            disabled={approve.isPending}
          >
            {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
        </div>
      )}
      {entry.state === 'proposed' && !canApprove && (
        <p className="text-xs text-muted-foreground">
          Approval needs a person with playbook.approve (owner, admin or brand manager).
        </p>
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Approving a playbook entry needs playbook.approve for this brand.`}
          data-testid="playbook-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={approve.error} title="The entry was not approved" />
      )}
    </li>
  );
}

/** Spec 16.9 "Brand playbook": approved practices with evidence, strength and reconsider-by date; proposals below. */
export function PlaybookPanel({ brandId, view, insights, canApprove }: PlaybookPanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const proposed = useProposedPlaybook(brandId);
  const intent = useIntentKey();
  const [practice, setPractice] = useState('');
  const [strength, setStrength] = useState<string>('observed');
  const [reviewAfter, setReviewAfter] = useState(() => isoToLocalInput(defaultReviewAfter()));
  const [evidence, setEvidence] = useState<string[]>([]);
  const propose = useMutation(
    trpc.intelligence.playbook.propose.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setPractice('');
        setEvidence([]);
        void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const iso = localInputToIso(reviewAfter);
    if (!practice.trim() || !evidence.length || !iso) return;
    propose.mutate({
      brandId,
      practice: practice.trim(),
      evidenceInsightIds: evidence,
      strength: EvidenceStrength.parse(strength),
      reviewAfter: iso,
    });
  };
  const toggle = (id: string) =>
    setEvidence((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const ui = propose.isError ? toUiError(propose.error) : null;
  const due = new Set(view.dueForReview);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Approved practices" data-testid="playbook-approved">
        <FreshnessLine freshness={view.freshness} statement={view.statement} />
        {view.items.length === 0 ? (
          <EmptyState
            title="No approved practices yet"
            description="Practices enter the playbook only when a person with playbook.approve approves a proposal. Nothing is written from engagement gains automatically."
          />
        ) : (
          <ul className="divide-y divide-border" aria-label="Approved practices">
            {view.items.map((p) => (
              <EntryRow key={p.id} entry={p} dueForReview={due.has(p.id)} canApprove={canApprove} />
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Proposed practices" data-testid="playbook-proposed">
        {proposed.isPending && <Skeleton label="Loading proposals" />}
        {proposed.isError && <RequestError error={proposed.error} onRetry={() => void proposed.refetch()} />}
        {proposed.data && proposed.data.items.length === 0 && (
          <EmptyState
            title="No proposals waiting"
            description="Propose a practice below, or accept a recommendation that proposes a playbook update."
          />
        )}
        {proposed.data && proposed.data.items.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Proposed practices">
            {proposed.data.items.map((p) => (
              <EntryRow key={p.id} entry={p} dueForReview={false} canApprove={canApprove} />
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Propose a practice" id="propose-practice">
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <Field
            label="Practice"
            htmlFor="pb-practice"
            error={ui?.details.find((d) => d.path === 'practice')?.issue}
          >
            <Textarea
              id="pb-practice"
              value={practice}
              onChange={(e) => setPractice(e.target.value)}
              rows={3}
              required
            />
          </Field>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium text-muted-foreground">
              Evidence (at least one insight)
            </legend>
            {insights.length === 0 && (
              <p className="text-xs text-muted-foreground">No insights to cite yet; run an analysis first.</p>
            )}
            {insights.map((i) => (
              <label key={i.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={evidence.includes(i.id)}
                  onChange={() => toggle(i.id)}
                />
                <span>{i.statement}</span>
              </label>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Strength" htmlFor="pb-strength">
              <Select
                id="pb-strength"
                value={strength}
                onValueChange={setStrength}
                options={EvidenceStrength.options.map((s) => ({ value: s, label: STRENGTH_CHIP[s].label }))}
              />
            </Field>
            <Field label="Reconsider by" htmlFor="pb-review">
              <Input
                id="pb-review"
                type="datetime-local"
                value={reviewAfter}
                onChange={(e) => setReviewAfter(e.target.value)}
                required
              />
            </Field>
          </div>
          {ui && ui.kind === 'forbidden' && (
            <StatusBanner
              tone="critical"
              title="Permission denied"
              description={`${ui.message} Proposing needs insight.manage for this brand.`}
            />
          )}
          {ui && ui.kind !== 'forbidden' && (
            <RequestError error={propose.error} title="The practice was not proposed" />
          )}
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={propose.isPending || !practice.trim() || !evidence.length}
              disabledReason={
                !practice.trim()
                  ? 'Write the practice first'
                  : !evidence.length
                    ? 'Cite at least one insight'
                    : undefined
              }
            >
              {propose.isPending ? 'Proposing…' : 'Propose'}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
