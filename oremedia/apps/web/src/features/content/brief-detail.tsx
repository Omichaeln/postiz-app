import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import type { ChannelDto } from '../publishing/use-publishing';
import {
  briefChip,
  briefGaps,
  isSuggested,
  packageChip,
  parseIds,
  rememberPackageDocuments,
} from './content-helpers';
import { useBrief, type PackageSummaryDto } from './use-content';

export interface BriefDetailProps {
  brandId: string;
  briefId: string;
  channels: ReadonlyMap<string, ChannelDto>;
  /** The brand's recent packages (the calendar window); this brief's are the ones pointing at it. */
  packages: readonly PackageSummaryDto[] | undefined;
  packagesWindow: string;
  selectedPackageId: string | null;
  onSelectPackage: (contentPackageId: string) => void;
}

function CreatePackageForm({
  brandId,
  briefId,
  onCreated,
}: {
  brandId: string;
  briefId: string;
  onCreated: (contentPackageId: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [docs, setDocs] = useState('');
  const create = useMutation(
    trpc.content.packages.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res, vars) => {
        intent.renew();
        rememberPackageDocuments(res.contentPackageId, vars.creativeDocumentIds ?? []);
        setTitle('');
        setText('');
        setDocs('');
        void queryClient.invalidateQueries(trpc.content.pathFilter());
        onCreated(res.contentPackageId);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    create.mutate({
      brandId,
      briefId,
      title: title.trim(),
      copy: { schemaVersion: 1, master: { text, factRefs: [] } },
      creativeDocumentIds: parseIds(docs),
    });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <Field label="Package title" htmlFor="pkg-title">
        <Input
          id="pkg-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
        />
      </Field>
      <Field label="Master copy" htmlFor="pkg-copy">
        <Textarea id="pkg-copy" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
      </Field>
      <Field
        label="Creative document ids"
        htmlFor="pkg-docs"
        hint="doc_…, comma separated. Revision 1 pins their current revisions."
      >
        <Input id="pkg-docs" value={docs} onChange={(e) => setDocs(e.target.value)} />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Creating a package needs content.edit.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={create.error} title="The package was not created" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={create.isPending || !title.trim()}
          disabledReason={title.trim() ? undefined : 'Give the package a title'}
        >
          {create.isPending ? 'Creating…' : 'Create package'}
        </Button>
      </div>
    </form>
  );
}

/** Spec 21.2 campaign planner: incomplete brief, suggested plan awaiting acceptance, accepted plan, and its packages. */
export function BriefDetail({
  brandId,
  briefId,
  channels,
  packages,
  packagesWindow,
  selectedPackageId,
  onSelectPackage,
}: BriefDetailProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const brief = useBrief(briefId);
  const intent = useIntentKey();
  const accept = useMutation(
    trpc.content.briefs.accept.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const b = brief.data;
  const acceptUi = accept.isError ? toUiError(accept.error) : null;
  const mine = (packages ?? []).filter((p) => p.briefId === briefId);
  const chip = b ? briefChip(b.state) : null;
  const gaps = b ? briefGaps(b) : [];

  return (
    <Panel title="Brief" data-testid="brief-detail">
      {brief.isPending && <Skeleton label="Loading brief" />}
      {brief.isError && (
        <RequestError
          error={brief.error}
          onRetry={() => void brief.refetch()}
          title={toUiError(brief.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {b && chip && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={chip.tone} data-testid="brief-state">
              {chip.label}
            </Badge>
            {isSuggested(b) && (
              <Badge tone="info" glyph={false}>
                Suggested plan
              </Badge>
            )}
            {gaps.length > 0 && <Badge tone="warning">Incomplete</Badge>}
            <code className="text-xs text-muted-foreground">{b.id}</code>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Audience</dt>
            <dd>{b.audience || 'not set'}</dd>
            <dt className="text-muted-foreground">Message</dt>
            <dd className="whitespace-pre-wrap break-words">{b.message || 'not set'}</dd>
            <dt className="text-muted-foreground">Channels</dt>
            <dd>
              {b.channelConnectionIds.length
                ? b.channelConnectionIds
                    .map((id) => {
                      const c = channels.get(id);
                      return c ? `${c.displayName} (${c.providerKey})` : id;
                    })
                    .join(', ')
                : 'none planned'}
            </dd>
            <dt className="text-muted-foreground">Constraints</dt>
            <dd>{b.constraints.length ? b.constraints.join('; ') : 'none'}</dd>
            {b.recommendationId && (
              <>
                <dt className="text-muted-foreground">From recommendation</dt>
                <dd>
                  <code>{b.recommendationId}</code>
                </dd>
              </>
            )}
          </dl>
          {gaps.length > 0 && (
            <StatusBanner
              tone="warning"
              title="Incomplete brief"
              description={`Missing: ${gaps.join(', ')}. A plan produced from it will have to guess these.`}
              data-testid="brief-incomplete"
            />
          )}
          {b.state === 'draft' && (
            <StatusBanner
              tone="warning"
              title="Awaiting acceptance"
              description={`${chip.detail ?? ''}${isSuggested(b) ? ' This plan was suggested, not written by a person.' : ''}`}
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => accept.mutate({ briefId: b.id, expectedVersion: b.version })}
                  disabled={accept.isPending}
                >
                  {accept.isPending ? 'Accepting…' : 'Accept brief'}
                </Button>
              }
              data-testid="brief-awaiting"
            />
          )}
          {acceptUi && acceptUi.kind === 'forbidden' && (
            <StatusBanner
              tone="critical"
              title="Permission denied"
              description={`${acceptUi.message} Accepting a brief needs content.plan for this brand.`}
              data-testid="brief-denied"
            />
          )}
          {acceptUi && acceptUi.kind !== 'forbidden' && (
            <RequestError error={accept.error} title="The brief was not accepted" />
          )}
          <section aria-labelledby="brief-packages" className="flex flex-col gap-2">
            <h3 id="brief-packages" className="text-sm font-semibold">
              Content packages
            </h3>
            <p className="text-xs text-muted-foreground">Packages touched {packagesWindow}.</p>
            {mine.length === 0 ? (
              <EmptyState
                title="No packages for this brief"
                description={
                  b.state === 'draft'
                    ? 'Accept the brief, then create its first content package.'
                    : 'Create the first content package below.'
                }
              />
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Content packages">
                {mine.map((p) => {
                  const pc = packageChip(p.state);
                  const selected = p.id === selectedPackageId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectPackage(p.id)}
                        data-testid={`package-${p.id}`}
                        className={`flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-accent bg-secondary' : 'border-border hover:bg-muted'}`}
                      >
                        <span className="font-medium">{p.title}</span>
                        <Badge tone={pc.tone}>{pc.label}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {b.state !== 'draft' && b.state !== 'cancelled' && (
              <CreatePackageForm brandId={brandId} briefId={b.id} onCreated={onSelectPackage} />
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
