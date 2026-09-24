import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Input, Panel, StatusBanner } from '@oremedia/ui';
import { PageHeading } from '../../../../../../components/request-state';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { useBrandVersions, useFacts } from '../../../../../../features/brand/use-brand';
import { readRecentDocuments, rememberDocument } from '../../../../../../lib/recent-documents';
import { useTRPC } from '../../../../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../../../../lib/intent-key';
import { toUiError } from '../../../../../../lib/errors';

/** Spec 21.2 brand home states: setup incomplete; outdated standards; action needed. All from live data. */
export function BrandHomeRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  const versions = useBrandVersions(brandId);
  const proposedFacts = useFacts(brandId, 'proposed');
  const published = versions.data?.items.find((v) => v.id === brand.publishedVersionId) ?? null;
  const newerDraft =
    published && versions.data
      ? versions.data.items.find((v) => v.number > published.number && v.state !== 'retired')
      : null;
  const proposedCount = proposedFacts.data?.items.length ?? 0;
  const system = brandPath(companyId, brandId, 'system');

  return (
    <main id="main" className="mx-auto w-full max-w-4xl p-6">
      <PageHeading title={brand.name} description="Priorities, what needs attention, and where to start." />
      <div className="mb-6 flex flex-col gap-2">
        {(brand.status === 'setup' || !brand.publishedVersionId) && (
          <StatusBanner
            tone="warning"
            title="Setup incomplete"
            description={
              brand.publishedVersionId
                ? 'The brand is still marked as in setup.'
                : 'No brand standards have been published. Documents cannot be created until a brand version is published.'
            }
            actions={
              <Button asChild size="sm">
                <Link to={system}>Open brand system</Link>
              </Button>
            }
          />
        )}
        {newerDraft && (
          <StatusBanner
            tone="info"
            title="Outdated standards"
            description={`Version ${newerDraft.number} (${newerDraft.state === 'in_review' ? 'in review' : 'proposed'}) is newer than the published version ${published?.number}. Documents keep the published version until the new one is published.`}
            actions={
              <Button asChild size="sm">
                <Link to={system}>Review</Link>
              </Button>
            }
          />
        )}
        {proposedCount > 0 && (
          <StatusBanner
            tone="warning"
            title="Action needed"
            description={`${proposedCount} proposed ${proposedCount === 1 ? 'fact awaits' : 'facts await'} approval before agents and validation can rely on them.`}
            actions={
              <Button asChild size="sm">
                <Link to={`${system}#facts`}>Review facts</Link>
              </Button>
            }
          />
        )}
        {brand.status === 'active' && brand.publishedVersionId && !newerDraft && proposedCount === 0 && (
          <StatusBanner
            tone="good"
            title="Nothing needs attention"
            description="Standards are published and no facts are waiting."
          />
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <NewDocument
          disabledReason={brand.publishedVersionId ? undefined : 'Publish brand standards first'}
        />
        <RecentDocuments />
      </div>
      <StatusBanner
        className="mt-6"
        tone="info"
        title="Calendar strip and agent activity"
        description="The calendar strip arrives with publishing (Phase 5) and agent activity with the agent runtime (Phase 4)."
      />
    </main>
  );
}

function NewDocument({ disabledReason }: { disabledReason?: string }) {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const intent = useIntentKey();
  const [title, setTitle] = useState('');
  const [openId, setOpenId] = useState('');
  const create = useMutation(
    trpc.creative.documents.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        rememberDocument({ companyId, brandId, documentId: res.documentId, title: title.trim() });
        navigate(brandPath(companyId, brandId, `studio/${encodeURIComponent(res.documentId)}`));
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate({ brandId, title: title.trim() });
  };
  return (
    <Panel title="Creative studio">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field
          label="New document title"
          htmlFor="doc-title"
          error={create.isError ? toUiError(create.error).message : undefined}
        >
          <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || !title.trim()}
            disabledReason={disabledReason}
          >
            {create.isPending ? 'Creating…' : 'Create and open'}
          </Button>
        </div>
      </form>
      <form
        className="mt-4 flex items-end gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (openId.trim())
            navigate(brandPath(companyId, brandId, `studio/${encodeURIComponent(openId.trim())}`));
        }}
      >
        <Field label="Open a document by id" htmlFor="doc-id" className="flex-1" hint="doc_…">
          <Input id="doc-id" value={openId} onChange={(e) => setOpenId(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!openId.trim()}>
          Open
        </Button>
      </form>
    </Panel>
  );
}

function RecentDocuments() {
  const { companyId, brandId } = useBrandContext();
  const recent = readRecentDocuments(companyId, brandId);
  return (
    <Panel title="Recently opened on this device">
      {recent.length === 0 ? (
        <EmptyState
          title="No documents opened on this device"
          description="A document list per brand arrives with campaigns (Phase 4); this list is a per-browser convenience."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {recent.map((d) => (
            <li key={d.documentId} className="flex items-center justify-between gap-2 py-2">
              <Link
                to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.documentId)}`)}
                className="text-sm font-medium"
              >
                {d.title || d.documentId}
              </Link>
              <Badge glyph={false}>{new Date(d.openedAt).toLocaleDateString()}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
