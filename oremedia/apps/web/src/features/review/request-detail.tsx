import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FrozenManifestV1, ReviewDecisionKind } from '@oremedia/contracts/review';
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
import { useToast } from '../../components/toast';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import type { ChannelDto } from '../publishing/use-publishing';
import {
  ATTENTION_CHIP,
  REQUEST_STATE_CHIP,
  invalidatedReasonText,
  manifestChannels,
  reviewLinkUrl,
  shortHash,
  staleReasonText,
  timingText,
} from './review-attention';
import {
  isMemberView,
  useReviewRequest,
  type ExternalLinkCreatedDto,
  type MemberReviewRequestDto,
} from './use-review';

const when = (iso: string) => new Date(iso).toLocaleString();

/** Where reviewer links open: the portal origin (spec 21.1) or, without one configured, this app's portal route. */
export const portalBase = (): string =>
  (import.meta.env['VITE_REVIEW_PORTAL_URL'] as string | undefined) ??
  `${window.location.origin}/review-portal`;

/** Spec 13.3: exactly what the reviewer sees. Shared by the inbox detail and the external portal. */
export function ManifestSummary({
  manifest,
  manifestHash,
  channels,
}: {
  manifest: FrozenManifestV1;
  manifestHash: string;
  channels?: ReadonlyMap<string, ChannelDto>;
}) {
  const name = (id: string) => {
    const c = channels?.get(id);
    return c ? `${c.displayName} (${c.providerKey})` : id;
  };
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="manifest">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Content revision</dt>
        <dd>
          <code>{manifest.contentRevisionId}</code> (content hash{' '}
          <code>{shortHash(manifest.contentHash)}</code>)
        </dd>
        <dt className="text-muted-foreground">Creative revisions</dt>
        <dd>
          {manifest.creativeRevisionIds.length
            ? manifest.creativeRevisionIds.map((id) => (
                <code key={id} className="mr-1">
                  {id}
                </code>
              ))
            : 'none'}
        </dd>
        <dt className="text-muted-foreground">Timing</dt>
        <dd>{timingText(manifest.timing)}</dd>
        <dt className="text-muted-foreground">Brand version</dt>
        <dd>
          <code>{manifest.brandVersionId}</code>, policy <code>{manifest.policyVersionId}</code>
        </dd>
        <dt className="text-muted-foreground">Manifest hash</dt>
        <dd>
          <code data-testid="manifest-hash">{manifestHash}</code>
        </dd>
      </dl>
      <ul className="flex flex-col gap-2" aria-label="Channel variants in this manifest">
        {manifestChannels(manifest).map((c) => (
          <li key={c.channelConnectionId} className="rounded-md border border-border p-2">
            <p className="text-xs font-semibold">{name(c.channelConnectionId)}</p>
            <p className="mt-1 whitespace-pre-wrap">{c.text}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {c.exportCount} rendered file{c.exportCount === 1 ? '' : 's'}
              {c.altTexts.length > 0 && `; alt text: ${c.altTexts.join(' / ')}`}; settings hash{' '}
              <code>{shortHash(c.settingsHash)}</code>
            </p>
          </li>
        ))}
        {manifest.captions.length === 0 && (
          <li className="text-xs text-muted-foreground">No channel variants were frozen.</li>
        )}
      </ul>
    </div>
  );
}

export interface RequestDetailProps {
  reviewRequestId: string | null;
  channels: ReadonlyMap<string, ChannelDto>;
}

/** Spec 21.2 inbox states: changes requested, stale approval, revoked external access, decided. */
export function RequestDetail({ reviewRequestId, channels }: RequestDetailProps) {
  const request = useReviewRequest(reviewRequestId);
  return (
    <Panel title="Review request" data-testid="request-detail">
      {reviewRequestId === null && (
        <EmptyState
          title="Nothing selected"
          description="Open a request from the inbox to see its frozen manifest, decide on it or share it with an external reviewer."
        />
      )}
      {reviewRequestId !== null && request.isPending && <Skeleton label="Loading request" />}
      {reviewRequestId !== null && request.isError && (
        <RequestError error={request.error} onRetry={() => void request.refetch()} />
      )}
      {request.isSuccess && !isMemberView(request.data) && (
        <StatusBanner
          tone="warning"
          title="Reviewer view only"
          description="This session sees the frozen manifest only; decisions from here belong in the review portal."
        />
      )}
      {request.isSuccess && isMemberView(request.data) && (
        <MemberDetail request={request.data} channels={channels} />
      )}
    </Panel>
  );
}

function MemberDetail({
  request: r,
  channels,
}: {
  request: MemberReviewRequestDto;
  channels: ReadonlyMap<string, ChannelDto>;
}) {
  const state = REQUEST_STATE_CHIP[r.state];
  const validApproval = r.approvals.find((a) => a.state === 'valid');
  const invalidated = r.approvals.filter((a) => a.state === 'invalidated');
  const revokedLinks = r.externalLinks.filter((l) => l.revokedAt !== null);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={state.tone} data-testid="request-state">
          {state.label}
        </Badge>
        <span className="text-muted-foreground">
          Revision <code>{r.contentRevisionId}</code> · requested {when(r.createdAt)}
          {r.dueAt && ` · due ${when(r.dueAt)}`}
        </span>
      </div>
      {r.state === 'stale' && (
        <StatusBanner
          tone="warning"
          title="Stale: the package changed after this request was frozen"
          description={`What changed: ${staleReasonText(r.staleReason)}. Reviewers are told the same. Ask for a new review request on the current package; this one cannot be decided.`}
        />
      )}
      {r.state === 'decided' && r.revisionState === 'changes_requested' && (
        <StatusBanner
          tone="warning"
          title={ATTENTION_CHIP.changes_requested.label}
          description={ATTENTION_CHIP.changes_requested.detail}
        />
      )}
      {r.state === 'decided' && validApproval && (
        <StatusBanner
          tone="good"
          title="Approved"
          description={`Approval ${validApproval.id} binds this exact package${validApproval.validUntil ? ` until ${when(validApproval.validUntil)}` : ''}. Dispatch recomputes the binding and holds the publication if anything changed.`}
        />
      )}
      {invalidated.map((a) => (
        <StatusBanner
          key={a.id}
          tone="critical"
          title="Approval invalidated"
          description={`Approval ${a.id} no longer releases anything because ${invalidatedReasonText(a.invalidatedReason)}. A new review is needed.`}
        />
      ))}
      {revokedLinks.length > 0 && (
        <StatusBanner
          tone="neutral"
          title={ATTENTION_CHIP.external_access_revoked.label}
          description={`${revokedLinks.length} external reviewer link${revokedLinks.length === 1 ? '' : 's'} revoked (${revokedLinks.map((l) => l.email).join(', ')}). Revocation takes effect on the reviewer's next request.`}
        />
      )}

      <section aria-labelledby={`manifest-${r.id}`}>
        <h3 id={`manifest-${r.id}`} className="mb-1 text-xs font-semibold">
          Frozen manifest
        </h3>
        <ManifestSummary manifest={r.frozenManifest} manifestHash={r.manifestHash} channels={channels} />
      </section>

      <section aria-labelledby={`decisions-${r.id}`}>
        <h3 id={`decisions-${r.id}`} className="mb-1 text-xs font-semibold">
          Decisions
        </h3>
        {r.decisions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No decision yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs" data-testid="decisions">
            {r.decisions.map((d) => (
              <li key={d.id} className="rounded-md border border-border p-2">
                <Badge tone={d.decision === 'approve' ? 'good' : 'warning'}>
                  {d.decision === 'approve'
                    ? 'Approved'
                    : d.decision === 'reject'
                      ? 'Rejected'
                      : 'Changes requested'}
                </Badge>{' '}
                by{' '}
                {d.deciderKind === 'external_reviewer'
                  ? `external reviewer${d.verifiedEmail ? ` ${d.verifiedEmail}` : ''}`
                  : `member ${d.deciderId}`}{' '}
                on {when(d.createdAt)}
                {d.comment && <p className="mt-1 whitespace-pre-wrap">{d.comment}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {r.state === 'open' && <DecisionForm reviewRequestId={r.id} manifestHash={r.manifestHash} />}
      <ExternalLinks request={r} />
    </div>
  );
}

const DECISIONS: Array<[ReviewDecisionKind, string]> = [
  ['approve', 'Approve'],
  ['request_changes', 'Request changes'],
];

/** Spec 13.2: the decision names the manifest hash it was made on; a mismatch is refused and shown. */
export function DecisionForm({
  reviewRequestId,
  manifestHash,
  onDecided,
}: {
  reviewRequestId: string;
  manifestHash: string;
  onDecided?: (decision: ReviewDecisionKind) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<ReviewDecisionKind>('approve');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const intent = useIntentKey();
  const submit = useMutation(
    trpc.review.decisions.submit.mutationOptions({
      ...intentContext(intent.key),
      onSuccess: () => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.review.pathFilter());
        onDecided?.(decision);
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (decision !== 'approve' && !comment.trim()) {
      setError('Say what should change.');
      return;
    }
    setError(null);
    submit.mutate({
      reviewRequestId,
      decision,
      comment: comment.trim() || undefined,
      expectedManifestHash: manifestHash,
    });
  };
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      noValidate
      data-testid="decision-form"
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-semibold">Your decision</legend>
        {DECISIONS.map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`decision-${reviewRequestId}`}
              value={value}
              checked={decision === value}
              onChange={() => setDecision(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <Field
        label={decision === 'approve' ? 'Comment (optional)' : 'What should change'}
        htmlFor={`comment-${reviewRequestId}`}
        error={error ?? undefined}
      >
        <Textarea
          id={`comment-${reviewRequestId}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={4000}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Decided on manifest <code>{shortHash(manifestHash)}</code>; if the package changed since, the decision
        is refused and the request goes stale.
      </p>
      <div>
        <Button type="submit" variant="primary" disabled={submit.isPending}>
          {submit.isPending ? 'Recording…' : decision === 'approve' ? 'Approve' : 'Request changes'}
        </Button>
      </div>
    </form>
  );
}

const defaultExpiry = () => {
  const d = new Date(Date.now() + 7 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Spec 5.6: expiring, revocable links; the token is shown once, here, and never again. */
function ExternalLinks({ request: r }: { request: MemberReviewRequestDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [expires, setExpires] = useState(defaultExpiry);
  const [created, setCreated] = useState<ExternalLinkCreatedDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => void queryClient.invalidateQueries(trpc.review.pathFilter());
  const createIntent = useIntentKey();
  const create = useMutation(
    trpc.review.externalLinks.create.mutationOptions({
      ...intentContext(createIntent.key),
      onSuccess: (res) => {
        createIntent.renew();
        setError(null);
        setCreated(res);
        setCopied(false);
        setEmail('');
        invalidate();
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );
  const revokeIntent = useIntentKey();
  const revoke = useMutation(
    trpc.review.externalLinks.revoke.mutationOptions({
      ...intentContext(revokeIntent.key),
      onSuccess: () => {
        revokeIntent.renew();
        invalidate();
        toast({
          tone: 'good',
          title: 'Link revoked',
          description: 'It stops working on the reviewer’s next request.',
        });
      },
      onError: (err) =>
        toast({ tone: 'critical', title: 'Revoke failed', description: toUiError(err).message }),
    }),
  );
  const link = created ? reviewLinkUrl(portalBase(), r.id, created.token, created.expiresAt) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
      toast({
        tone: 'warning',
        title: 'Copy blocked',
        description: 'Select the link text and copy it by hand.',
      });
    }
  };
  return (
    <section aria-labelledby={`links-${r.id}`} className="flex flex-col gap-3">
      <h3 id={`links-${r.id}`} className="text-xs font-semibold">
        External reviewers
      </h3>
      {created && (
        <StatusBanner
          tone="info"
          title="Link created: copy it now, it is shown only once"
          data-testid="link-once"
          description={
            <div className="flex flex-col gap-2">
              <span>
                For {r.externalLinks.find((l) => l.id === created.linkId)?.email ?? 'the reviewer'}, valid
                until {when(created.expiresAt)}. The token is not stored in a readable form anywhere; closing
                this notice loses it.
              </span>
              <Input
                readOnly
                value={link}
                aria-label="Review link"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="link-url"
              />
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  I have shared it
                </Button>
              </span>
            </div>
          }
        />
      )}
      {r.externalLinks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No external reviewer links.</p>
      ) : (
        <ul
          className="flex flex-col gap-1 text-xs"
          aria-label="External reviewer links"
          data-testid="external-links"
        >
          {r.externalLinks.map((l) => {
            const expired = new Date(l.expiresAt).getTime() < Date.now();
            return (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
              >
                <span className="font-medium">{l.email}</span>
                {l.revokedAt ? (
                  <Badge tone="neutral">Revoked {when(l.revokedAt)}</Badge>
                ) : expired ? (
                  <Badge tone="warning">Expired {when(l.expiresAt)}</Badge>
                ) : (
                  <Badge tone="good">Active until {when(l.expiresAt)}</Badge>
                )}
                {l.emailVerifiedAt && (
                  <span className="text-muted-foreground">verified {when(l.emailVerifiedAt)}</span>
                )}
                {l.lastUsedAt && (
                  <span className="text-muted-foreground">last used {when(l.lastUsedAt)}</span>
                )}
                {!l.revokedAt && (
                  <Button
                    size="sm"
                    variant="danger"
                    className="ml-auto"
                    onClick={() => revoke.mutate({ linkId: l.id })}
                    disabled={revoke.isPending}
                    aria-label={`Revoke link for ${l.email}`}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {r.state === 'open' && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const d = new Date(expires);
            if (!email.trim() || Number.isNaN(d.getTime())) {
              setError('An email address and an expiry are required.');
              return;
            }
            create.mutate({ reviewRequestId: r.id, email: email.trim(), expiresAt: d.toISOString() });
          }}
        >
          <Field
            label="Reviewer email"
            htmlFor={`link-email-${r.id}`}
            className="flex-1"
            error={error ?? undefined}
          >
            <Input
              id={`link-email-${r.id}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label="Expires" htmlFor={`link-expires-${r.id}`}>
            <Input
              id={`link-expires-${r.id}`}
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create link'}
          </Button>
        </form>
      )}
    </section>
  );
}
