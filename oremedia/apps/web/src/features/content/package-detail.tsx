import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, Input, Panel, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { CHANNEL_CHIP, isoToLocalInput, localInputToIso } from '../publishing/publication-state';
import type { ChannelDto } from '../publishing/use-publishing';
import {
  packageChip,
  parseIds,
  readPackageDocuments,
  rememberPackageDocuments,
  revisionChip,
  variantFindings,
} from './content-helpers';
import { usePackage, type PackageDto, type PackageVariantDto } from './use-content';

export interface PackageDetailProps {
  companyId: string;
  brandId: string;
  contentPackageId: string;
  channels: ReadonlyMap<string, ChannelDto>;
}

function StudioLinks({
  companyId,
  brandId,
  documentIds,
}: {
  companyId: string;
  brandId: string;
  documentIds: string[];
}) {
  if (documentIds.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No studio documents were chosen for this package on this device. The content revision pins creative
        revisions, not documents; open a document from the brand home by its id.
      </p>
    );
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Studio documents" data-testid="studio-links">
      {documentIds.map((id) => (
        <li key={id}>
          <Link
            to={brandPath(companyId, brandId, `studio/${encodeURIComponent(id)}`)}
            className="text-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open {id} in the studio
          </Link>
        </li>
      ))}
    </ul>
  );
}

function VariantRow({ variant, channel }: { variant: PackageVariantDto; channel: ChannelDto | undefined }) {
  const findings = variantFindings(variant.validation);
  const status = channel ? CHANNEL_CHIP[channel.status] : null;
  return (
    <li
      className="flex flex-col gap-1 py-2"
      data-testid="variant"
      data-variant-valid={findings.ok ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {channel ? `${channel.displayName} (${channel.providerKey})` : variant.channelConnectionId}
        </span>
        {status && status.needsAction && <Badge tone={status.tone}>{status.label}</Badge>}
        <Badge tone={findings.ok ? 'good' : 'critical'}>{findings.ok ? 'Valid' : 'Invalid'}</Badge>
        <code className="text-xs text-muted-foreground">{variant.id}</code>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{variant.text}</p>
      {!findings.ok && (
        <ul
          className="list-disc pl-5 text-xs"
          aria-label={`Findings for ${variant.id}`}
          data-testid="variant-findings"
        >
          {findings.issues.length === 0 && <li>The channel capability check did not pass.</li>}
          {findings.issues.map((f, i) => (
            <li key={i}>
              {f.path ? <code>{f.path}</code> : null} {f.issue}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function GenerateVariantsForm({
  pkg,
  channels,
}: {
  pkg: PackageDto;
  channels: ReadonlyMap<string, ChannelDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const existing = new Set(pkg.variants.map((v) => v.channelConnectionId));
  const [selected, setSelected] = useState<string[]>([]);
  const generate = useMutation(
    trpc.content.variants.generate.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setSelected([]);
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (selected.length)
      generate.mutate({ contentRevisionId: pkg.revision.id, channelConnectionIds: selected });
  };
  const ui = generate.isError ? toUiError(generate.error) : null;
  const options = [...channels.values()];
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">
          Channels for revision {pkg.revision.number} (one variant per channel; existing ones are kept)
        </legend>
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground">No channels are connected for this brand.</p>
        )}
        {options.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={existing.has(c.id) || selected.includes(c.id)}
              disabled={existing.has(c.id)}
              onChange={() => toggle(c.id)}
            />
            <span>
              {c.displayName} ({c.providerKey}){existing.has(c.id) ? ' · has a variant' : ''}
            </span>
          </label>
        ))}
      </fieldset>
      {generate.data && (
        <StatusBanner
          tone="good"
          title={`${generate.data.created.length} variant${generate.data.created.length === 1 ? '' : 's'} generated`}
          description="Each variant was checked against its channel's capability; findings are listed per variant."
          data-testid="variants-generated"
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Generating variants needs content.edit for this brand.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={generate.error} title="Variants were not generated" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={generate.isPending || selected.length === 0}
          disabledReason={selected.length === 0 ? 'Choose at least one channel' : undefined}
        >
          {generate.isPending ? 'Generating…' : 'Generate variants'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Spec 13.3: sends the current draft revision for review. The request freezes the revision, its channel variants and
 * the planned timing into a manifest; the revision moves to in review and the request opens in the review inbox.
 */
function RequestReview({ companyId, brandId, pkg }: { companyId: string; brandId: string; pkg: PackageDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [at, setAt] = useState(() => isoToLocalInput(new Date(Date.now() + 24 * 3_600_000).toISOString()));
  const [error, setError] = useState<string | null>(null);
  const request = useMutation(
    trpc.review.requests.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.content.pathFilter());
        void queryClient.invalidateQueries(trpc.review.pathFilter());
      },
    }),
  );
  if (request.data)
    return (
      <StatusBanner
        tone="good"
        title="Review requested"
        description={`Revision ${pkg.revision.number} and its channel variants are frozen for review (manifest ${request.data.manifestHash.slice(0, 12)}…).`}
        actions={
          <Button asChild size="sm">
            <Link
              to={brandPath(
                companyId,
                brandId,
                `review?request=${encodeURIComponent(request.data.reviewRequestId)}`,
              )}
            >
              Open in the review inbox
            </Link>
          </Button>
        }
        data-testid="review-requested"
      />
    );
  if (pkg.revision.state !== 'draft') return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const iso = localInputToIso(at);
    if (!iso) {
      setError('Enter the planned publish time.');
      return;
    }
    setError(null);
    request.mutate({ contentRevisionId: pkg.revision.id, timing: { kind: 'exact', at: iso } });
  };
  const ui = request.isError ? toUiError(request.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <Field
        label="Planned publish time"
        htmlFor={`review-at-${pkg.id}`}
        hint="Frozen into the review manifest; publishing outside it is held."
        error={error ?? undefined}
      >
        <Input
          id={`review-at-${pkg.id}`}
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          required
        />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Requesting a review needs review.request.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={request.error} title="The review was not requested" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={request.isPending}
          disabledReason={
            pkg.variants.length === 0 ? 'Generate at least one channel variant first' : undefined
          }
        >
          {request.isPending ? 'Requesting…' : 'Request review'}
        </Button>
      </div>
    </form>
  );
}

function ReviseForm({ pkg, onRevised }: { pkg: PackageDto; onRevised: (documentIds: string[]) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [text, setText] = useState(pkg.revision.copy.master.text);
  const [docs, setDocs] = useState(() => readPackageDocuments(pkg.id).join(', '));
  const [summary, setSummary] = useState('');
  const revise = useMutation(
    trpc.content.packages.revise.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (_res, vars) => {
        intent.renew();
        setSummary('');
        onRevised(vars.creativeDocumentIds ?? []);
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    revise.mutate({
      contentPackageId: pkg.id,
      expectedVersion: pkg.version,
      copy: { schemaVersion: 1, master: { text, factRefs: pkg.revision.copy.master.factRefs } },
      creativeDocumentIds: parseIds(docs),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
    });
  };
  const ui = revise.isError ? toUiError(revise.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <Field label="Master copy" htmlFor={`revise-${pkg.id}-copy`}>
        <Textarea
          id={`revise-${pkg.id}-copy`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      </Field>
      <Field
        label="Creative document ids"
        htmlFor={`revise-${pkg.id}-docs`}
        hint="doc_…, comma separated. Their current revisions are pinned."
      >
        <Input id={`revise-${pkg.id}-docs`} value={docs} onChange={(e) => setDocs(e.target.value)} />
      </Field>
      <Field label="Change summary (optional)" htmlFor={`revise-${pkg.id}-summary`}>
        <Input id={`revise-${pkg.id}-summary`} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Revising needs content.edit.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={revise.error} title="The package was not revised" />
      )}
      <div>
        <Button type="submit" size="sm" disabled={revise.isPending}>
          {revise.isPending ? 'Revising…' : 'Create next revision'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Spec 13 content package: the current revision with its state (in review, changes requested, approved), the revision
 * history (superseded revisions are kept, never edited), channel variants with their capability findings, and the
 * studio documents chosen for it on this device.
 */
export function PackageDetail({ companyId, brandId, contentPackageId, channels }: PackageDetailProps) {
  const pkg = usePackage(contentPackageId);
  const [documentIds, setDocumentIds] = useState(() => readPackageDocuments(contentPackageId));
  const p = pkg.data;
  const current = p ? revisionChip(p.revision.state) : null;
  return (
    <Panel title="Content package" data-testid="package-detail">
      {pkg.isPending && <Skeleton label="Loading content package" />}
      {pkg.isError && (
        <RequestError
          error={pkg.error}
          onRetry={() => void pkg.refetch()}
          title={toUiError(pkg.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {p && current && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{p.title}</span>
              <Badge tone={packageChip(p.state).tone}>{packageChip(p.state).label}</Badge>
              <code className="text-xs text-muted-foreground">{p.id}</code>
            </div>
          </div>
          <section aria-labelledby={`rev-${p.id}`} className="flex flex-col gap-2">
            <h3 id={`rev-${p.id}`} className="text-sm font-semibold">
              Revision {p.revision.number}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={current.tone} data-testid="revision-state">
                {current.label}
              </Badge>
              <code className="text-xs text-muted-foreground">{p.revision.id}</code>
            </div>
            {current.detail && (
              <p className="text-xs text-muted-foreground" data-testid="revision-detail">
                {current.detail}
              </p>
            )}
            <p className="whitespace-pre-wrap break-words text-sm">{p.revision.copy.master.text}</p>
            <p className="text-xs text-muted-foreground">
              Brand version <code>{p.revision.brandVersionId}</code> · policy{' '}
              <code>{p.revision.policyVersionId}</code> · {p.revision.creativeRevisionIds.length} creative
              revision
              {p.revision.creativeRevisionIds.length === 1 ? '' : 's'} pinned · hash{' '}
              <code>{p.revision.contentHash.slice(0, 12)}…</code>
            </p>
            <StudioLinks companyId={companyId} brandId={brandId} documentIds={documentIds} />
          </section>
          <section aria-labelledby={`history-${p.id}`} className="flex flex-col gap-1">
            <h3 id={`history-${p.id}`} className="text-sm font-semibold">
              Revision history
            </h3>
            <ol className="flex flex-col gap-1" aria-label="Revision history" data-testid="revision-history">
              {p.revisions.map((r) => {
                const chip = revisionChip(r.state);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="tabular-nums">#{r.number}</span>
                    <Badge tone={chip.tone}>{chip.label}</Badge>
                    <code className="text-xs text-muted-foreground">{r.id}</code>
                    <span className="text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-labelledby={`variants-${p.id}`} className="flex flex-col gap-1">
            <h3 id={`variants-${p.id}`} className="text-sm font-semibold">
              Channel variants
            </h3>
            {p.variants.length === 0 ? (
              <p className="text-sm text-muted-foreground">No variants for this revision yet.</p>
            ) : (
              <ul className="divide-y divide-border" aria-label="Channel variants">
                {p.variants.map((v) => (
                  <VariantRow key={v.id} variant={v} channel={channels.get(v.channelConnectionId)} />
                ))}
              </ul>
            )}
            <GenerateVariantsForm key={p.revision.id} pkg={p} channels={channels} />
          </section>
          <section aria-labelledby={`review-${p.id}`} className="flex flex-col gap-1">
            <h3 id={`review-${p.id}`} className="text-sm font-semibold">
              Review
            </h3>
            {p.revision.state !== 'draft' && (
              <p className="text-xs text-muted-foreground">
                Revision {p.revision.number} is {current.label.toLowerCase()}; only a draft revision can be
                sent for review.
              </p>
            )}
            <RequestReview key={p.revision.id} companyId={companyId} brandId={brandId} pkg={p} />
          </section>
          <ReviseForm
            key={p.version}
            pkg={p}
            onRevised={(ids) => {
              rememberPackageDocuments(p.id, ids);
              setDocumentIds(ids);
            }}
          />
        </div>
      )}
    </Panel>
  );
}
