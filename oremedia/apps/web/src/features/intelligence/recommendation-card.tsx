import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RecommendationAction } from '@oremedia/contracts/intelligence';
import { Badge, Button, Field, Input, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { localInputToIso, isoToLocalInput } from '../publishing/publication-state';
import { ACTION_LABEL, defaultReviewAfter, levelChip } from './intelligence-helpers';
import type { AcceptResultDto, RecommendationDto } from './use-intelligence';

export interface RecommendationCardProps {
  companyId: string;
  brandId: string;
  recommendation: RecommendationDto;
  /** Rank position in the list (1-based) when the list is ranked; null when unranked. */
  position: number | null;
  /** Called once the person decided (accepted or dismissed), so the list can keep the card and its outcome. */
  onDecided?: (recommendation: RecommendationDto) => void;
}

/** Spec 16.4: the downstream object gets a back-reference; the screen links to where it lives. */
export function downstreamHref(companyId: string, brandId: string, res: AcceptResultDto): string | null {
  const id = res.downstreamId;
  switch (res.downstreamType) {
    case 'brief':
      return id ? brandPath(companyId, brandId, `campaigns?brief=${encodeURIComponent(id)}`) : null;
    case 'experiment':
      return id ? brandPath(companyId, brandId, `experiments?experiment=${encodeURIComponent(id)}`) : null;
    case 'agent_run':
      return id ? brandPath(companyId, brandId, `agents?run=${encodeURIComponent(id)}`) : null;
    case 'playbook_entry':
      return brandPath(companyId, brandId, 'intelligence?view=playbook');
    case 'canvas':
      // Nothing is created server-side for open_canvas: the studio opens from the brand home.
      return brandPath(companyId, brandId, 'home');
    default:
      return null;
  }
}

const DESIGN_SKELETON = JSON.stringify(
  {
    v: 1,
    hypothesis: '',
    mode: 'structured_comparison',
    variants: [
      { label: 'A', contentRevisionId: '', allocationWeight: 1 },
      { label: 'B', contentRevisionId: '', allocationWeight: 1 },
    ],
    primaryMetricKey: '',
    guardrailMetricKeys: [],
    allocationMethod: 'matched_slots',
    unitType: 'publication_slot',
    minSamplePerArm: 30,
    observationWindowHours: 168,
    stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
  },
  null,
  2,
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One recommendation with exactly the actions the server offers (spec 16.4): its proposed action and dismiss
 * (reason required). Accepting creates the downstream object and the card links to it.
 */
export function RecommendationCard({
  companyId,
  brandId,
  recommendation: r,
  position,
  onDecided,
}: RecommendationCardProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const acceptIntent = useIntentKey();
  const dismissIntent = useIntentKey();
  const [open, setOpen] = useState<RecommendationAction | 'dismiss' | null>(null);
  const [audience, setAudience] = useState('');
  const [message, setMessage] = useState('');
  const [principalId, setPrincipalId] = useState('');
  const [design, setDesign] = useState(DESIGN_SKELETON);
  const [designError, setDesignError] = useState<string | null>(null);
  const [practice, setPractice] = useState(r.title);
  const [reviewAfter, setReviewAfter] = useState(() => isoToLocalInput(defaultReviewAfter()));
  const [reason, setReason] = useState('');
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
  };
  const accept = useMutation(
    trpc.intelligence.recommendations.accept.mutationOptions({
      ...mutationIntent(acceptIntent.key),
      onSuccess: () => {
        acceptIntent.renew();
        setOpen(null);
        onDecided?.(r);
        invalidate();
      },
    }),
  );
  const dismiss = useMutation(
    trpc.intelligence.recommendations.dismiss.mutationOptions({
      ...mutationIntent(dismissIntent.key),
      onSuccess: () => {
        dismissIntent.renew();
        setOpen(null);
        onDecided?.(r);
        invalidate();
      },
    }),
  );
  const submitAccept = (e: FormEvent) => {
    e.preventDefault();
    if (open === null || open === 'dismiss') return;
    const base = { recommendationId: r.id, expectedVersion: r.version, action: open };
    switch (open) {
      case 'create_brief':
        accept.mutate({ ...base, brief: { audience: audience.trim(), message: message.trim() } });
        return;
      case 'generate_variants':
        accept.mutate({ ...base, servicePrincipalId: principalId.trim() });
        return;
      case 'prepare_test': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(design);
        } catch (err) {
          setDesignError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (!isRecord(parsed)) {
          setDesignError('The design must be a JSON object.');
          return;
        }
        setDesignError(null);
        accept.mutate({ ...base, experimentDesign: parsed });
        return;
      }
      case 'propose_playbook_update': {
        const iso = localInputToIso(reviewAfter);
        if (!iso) return;
        accept.mutate({ ...base, playbook: { practice: practice.trim(), reviewAfter: iso } });
        return;
      }
      default:
        accept.mutate(base);
    }
  };
  const submitDismiss = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim())
      dismiss.mutate({ recommendationId: r.id, expectedVersion: r.version, reason: reason.trim() });
  };
  const acceptUi = accept.isError ? toUiError(accept.error) : null;
  const fieldIssue = (path: string) => acceptUi?.details.find((d) => d.path === path)?.issue;
  const effort = levelChip(r.effort);
  const uncertainty = levelChip(r.uncertainty);
  const formId = `rec-${r.id}`;
  const href = accept.data ? downstreamHref(companyId, brandId, accept.data) : null;

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid="recommendation"
      data-recommendation-state={accept.data?.state ?? dismiss.data?.state ?? r.state}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {position !== null && <span className="font-semibold">#{position}</span>}
        <span className="font-medium">{r.title}</span>
        <Badge tone="neutral" glyph={false}>
          {ACTION_LABEL[r.proposedAction]}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{r.rationale}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Expected benefit</dt>
        <dd>
          {r.expectedBenefit.metricKey} {r.expectedBenefit.direction}
          {r.expectedBenefit.magnitude ? ` (${r.expectedBenefit.magnitude})` : ''}
        </dd>
        <dt className="text-muted-foreground">Effort</dt>
        <dd>
          <Badge tone={effort.tone}>{effort.label}</Badge>
        </dd>
        <dt className="text-muted-foreground">Uncertainty</dt>
        <dd>
          <Badge tone={uncertainty.tone}>{uncertainty.label}</Badge>
        </dd>
        <dt className="text-muted-foreground">Evidence</dt>
        <dd>
          {r.insightIds.length
            ? r.insightIds.map((id) => (
                <code key={id} className="mr-1">
                  {id}
                </code>
              ))
            : 'none recorded'}
        </dd>
        {r.learning && (
          <>
            <dt className="text-muted-foreground">Hypothesis</dt>
            <dd>{r.learning.hypothesis}</dd>
          </>
        )}
      </dl>
      {accept.data && (
        <StatusBanner
          tone="good"
          title={`Accepted: ${ACTION_LABEL[accept.data.action]}`}
          description={
            <>
              {accept.data.downstreamId ? (
                <>
                  Created {accept.data.downstreamType.replace(/_/g, ' ')}{' '}
                  <code>{accept.data.downstreamId}</code> with a back-reference to this recommendation.
                </>
              ) : (
                <>
                  Your decision is recorded; open the {accept.data.downstreamType.replace(/_/g, ' ')} to act
                  on it.
                </>
              )}
            </>
          }
          actions={
            href && (
              <Button size="sm" asChild>
                <Link to={href}>Open</Link>
              </Button>
            )
          }
          data-testid="recommendation-accepted"
        />
      )}
      {dismiss.data && (
        <StatusBanner
          tone="neutral"
          title="Dismissed"
          description="The reason is stored with the learning record."
        />
      )}
      {!accept.data && !dismiss.data && r.actions.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={`Actions for ${r.title}`}>
          {r.actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'dismiss' ? 'ghost' : 'primary'}
              aria-expanded={open === a}
              aria-controls={`${formId}-form`}
              onClick={() => setOpen(open === a ? null : a)}
            >
              {a === 'dismiss' ? 'Dismiss' : ACTION_LABEL[a]}
            </Button>
          ))}
        </div>
      )}
      {open !== null && open !== 'dismiss' && (
        <form
          id={`${formId}-form`}
          onSubmit={submitAccept}
          className="flex flex-col gap-2 border-t border-border pt-2"
          noValidate
        >
          {open === 'create_brief' && (
            <>
              <Field label="Audience" htmlFor={`${formId}-audience`} error={fieldIssue('brief.audience')}>
                <Input
                  id={`${formId}-audience`}
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  required
                />
              </Field>
              <Field label="Message" htmlFor={`${formId}-message`} error={fieldIssue('brief.message')}>
                <Textarea
                  id={`${formId}-message`}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  required
                />
              </Field>
            </>
          )}
          {open === 'generate_variants' && (
            <Field
              label="Service principal"
              htmlFor={`${formId}-principal`}
              hint="sp_… of the agent principal the copywriting run acts as."
              error={fieldIssue('servicePrincipalId')}
            >
              <Input
                id={`${formId}-principal`}
                value={principalId}
                onChange={(e) => setPrincipalId(e.target.value)}
                required
              />
            </Field>
          )}
          {open === 'prepare_test' && (
            <Field
              label="Pre-registration draft (JSON)"
              htmlFor={`${formId}-design`}
              hint="Validated by the experiments module; the design is frozen when you pre-register it."
              error={designError ?? fieldIssue('experimentDesign')}
            >
              <Textarea
                id={`${formId}-design`}
                value={design}
                onChange={(e) => setDesign(e.target.value)}
                rows={8}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
          )}
          {open === 'propose_playbook_update' && (
            <>
              <Field label="Practice" htmlFor={`${formId}-practice`} error={fieldIssue('playbook.practice')}>
                <Textarea
                  id={`${formId}-practice`}
                  value={practice}
                  onChange={(e) => setPractice(e.target.value)}
                  rows={3}
                  required
                />
              </Field>
              <Field
                label="Reconsider by"
                htmlFor={`${formId}-review`}
                hint="Approval is a separate step for a person with playbook.approve."
              >
                <Input
                  id={`${formId}-review`}
                  type="datetime-local"
                  value={reviewAfter}
                  onChange={(e) => setReviewAfter(e.target.value)}
                  required
                />
              </Field>
            </>
          )}
          {(open === 'open_canvas' || open === 'assign_response') && (
            <p className="text-sm text-muted-foreground">
              Accepting records your decision and creates the downstream object with a back-reference.
            </p>
          )}
          {acceptUi && acceptUi.kind === 'forbidden' && (
            <StatusBanner
              tone="critical"
              title="Permission denied"
              description={`${acceptUi.message} Deciding on a recommendation needs insight.manage for this brand.`}
              data-testid="recommendation-denied"
            />
          )}
          {acceptUi && acceptUi.kind !== 'forbidden' && (
            <RequestError error={accept.error} title="The recommendation was not accepted" />
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={accept.isPending}>
              {accept.isPending ? 'Accepting…' : `Accept: ${ACTION_LABEL[open]}`}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {open === 'dismiss' && (
        <form
          id={`${formId}-form`}
          onSubmit={submitDismiss}
          className="flex flex-col gap-2 border-t border-border pt-2"
          noValidate
        >
          <Field
            label="Reason for dismissing"
            htmlFor={`${formId}-reason`}
            hint="Required. Stored with the learning record; it explains a preference, never how the creative would have performed."
          >
            <Textarea
              id={`${formId}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
            />
          </Field>
          {dismiss.isError && (
            <RequestError error={dismiss.error} title="The recommendation was not dismissed" />
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={dismiss.isPending || !reason.trim()}
              disabledReason={reason.trim() ? undefined : 'Give a reason first'}
            >
              {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
