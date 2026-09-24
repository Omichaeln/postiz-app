import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
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
import { PageHeading, RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { localInputToIso } from '../publishing/publication-state';
import { useChannels, type ChannelDto } from '../publishing/use-publishing';
import { BriefDetail } from './brief-detail';
import {
  briefChip,
  briefGaps,
  campaignChip,
  isSuggested,
  missedDate,
  packageWindow,
} from './content-helpers';
import { PackageDetail } from './package-detail';
import { useBriefs, useCampaigns, useRecentPackages } from './use-content';

const listButton = (selected: boolean) =>
  `flex w-full flex-col gap-1 rounded-md border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-accent bg-secondary' : 'border-border hover:bg-muted'}`;

function CreateCampaignForm({ brandId, onCreated }: { brandId: string; onCreated: (id: string) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const create = useMutation(
    trpc.content.campaigns.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setName('');
        void queryClient.invalidateQueries(trpc.content.campaigns.pathFilter());
        onCreated(res.campaignId);
      },
    }),
  );
  const from = localInputToIso(startsAt);
  const to = localInputToIso(endsAt);
  const ready = name.trim() !== '' && from !== null && to !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && from && to) create.mutate({ brandId, name: name.trim(), startsAt: from, endsAt: to });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  const issue = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <Field label="Campaign name" htmlFor="campaign-name">
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Starts" htmlFor="campaign-starts">
          <Input
            id="campaign-starts"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>
        <Field label="Ends" htmlFor="campaign-ends" error={issue('endsAt')}>
          <Input
            id="campaign-ends"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Planning campaigns needs content.plan.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && !issue('endsAt') && (
        <RequestError error={create.error} title="The campaign was not created" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={create.isPending || !ready}
          disabledReason={ready ? undefined : 'Give a name, a start and an end'}
        >
          {create.isPending ? 'Creating…' : 'Create campaign'}
        </Button>
      </div>
    </form>
  );
}

function CreateBriefForm({
  brandId,
  campaignId,
  channels,
  onCreated,
}: {
  brandId: string;
  campaignId: string | null;
  channels: readonly ChannelDto[];
  onCreated: (id: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [audience, setAudience] = useState('');
  const [message, setMessage] = useState('');
  const [constraints, setConstraints] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const create = useMutation(
    trpc.content.briefs.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setAudience('');
        setMessage('');
        setConstraints('');
        setSelected([]);
        void queryClient.invalidateQueries(trpc.content.briefs.pathFilter());
        onCreated(res.briefId);
      },
    }),
  );
  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      brandId,
      ...(campaignId ? { campaignId } : {}),
      audience: audience.trim(),
      message: message.trim(),
      channelConnectionIds: selected,
      constraints: constraints
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
    });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 border-t border-border pt-3" noValidate>
      <p className="text-xs text-muted-foreground">
        {campaignId
          ? 'The brief belongs to the selected campaign.'
          : 'No campaign selected: the brief stands alone.'}
      </p>
      <Field label="Audience" htmlFor="brief-audience">
        <Input
          id="brief-audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label="Message" htmlFor="brief-message">
        <Textarea id="brief-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">Planned channels</legend>
        {channels.length === 0 && <p className="text-xs text-muted-foreground">No channels connected.</p>}
        {channels.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            <span>
              {c.displayName} ({c.providerKey})
            </span>
          </label>
        ))}
      </fieldset>
      <Field label="Constraints" htmlFor="brief-constraints" hint="One per line.">
        <Textarea
          id="brief-constraints"
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          rows={2}
        />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Briefs need content.plan.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={create.error} title="The brief was not created" />
      )}
      <div>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create brief'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Spec 21.1 `campaigns/`: planner from brief to plan to assigned work (spec 13 content packages and revisions,
 * channel variants). Spec 21.2 states: incomplete brief, suggested plan, accepted plan, missed date; plus the
 * revision states and invalid variants. Campaign, brief and package selections live in the URL.
 */
export function CampaignsScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campaign');
  const briefId = params.get('brief');
  const packageId = params.get('package');
  const [pkgWindow] = useState(() => packageWindow());
  const campaigns = useCampaigns(brandId);
  const briefs = useBriefs(brandId, campaignId);
  const packages = useRecentPackages(brandId, pkgWindow.from, pkgWindow.to);
  const channels = useChannels(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const windowText = `between ${new Date(pkgWindow.from).toLocaleDateString()} and ${new Date(pkgWindow.to).toLocaleDateString()}`;
  const forbidden = campaigns.isError && toUiError(campaigns.error).kind === 'forbidden';

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <PageHeading
        title="Campaigns and briefs"
        description={`Plan ${brand.name}'s work from brief to content package. A revision is never edited: revising creates the next one and supersedes the current.`}
      />
      {channels.isError && (
        <RequestError
          error={channels.error}
          onRetry={() => void channels.refetch()}
          title="Channels could not be loaded"
        />
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Campaigns" data-testid="campaigns">
            {campaigns.isPending && <Skeleton label="Loading campaigns" lines={3} />}
            {campaigns.isError && (
              <RequestError
                error={campaigns.error}
                onRetry={() => void campaigns.refetch()}
                title={forbidden ? 'Permission denied' : undefined}
              />
            )}
            {campaigns.isSuccess && campaigns.data.items.length === 0 && (
              <EmptyState
                title="No campaigns yet"
                description="Create a campaign to group briefs, or write a standalone brief below."
              />
            )}
            {campaigns.isSuccess && campaigns.data.items.length > 0 && (
              <ul className="flex flex-col gap-1" aria-label="Campaigns">
                <li>
                  <button
                    type="button"
                    aria-pressed={campaignId === null}
                    onClick={() => update({ campaign: null })}
                    className={listButton(campaignId === null)}
                  >
                    All briefs
                  </button>
                </li>
                {campaigns.data.items.map((c) => {
                  const chip = campaignChip(c.state);
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        aria-pressed={c.id === campaignId}
                        onClick={() => update({ campaign: c.id, brief: null, package: null })}
                        className={listButton(c.id === campaignId)}
                        data-testid={`campaign-${c.id}`}
                      >
                        <span className="font-medium">{c.name}</span>
                        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge tone={chip.tone}>{chip.label}</Badge>
                          {missedDate(c) && <Badge tone="critical">Missed date</Badge>}
                          <span>
                            {new Date(c.startsAt).toLocaleDateString()} to{' '}
                            {new Date(c.endsAt).toLocaleDateString()}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {!forbidden && (
              <CreateCampaignForm brandId={brandId} onCreated={(id) => update({ campaign: id })} />
            )}
          </Panel>
          <Panel title={campaignId ? 'Briefs in this campaign' : 'Briefs'} data-testid="briefs">
            {briefs.isPending && <Skeleton label="Loading briefs" lines={3} />}
            {briefs.isError && <RequestError error={briefs.error} onRetry={() => void briefs.refetch()} />}
            {briefs.isSuccess && briefs.data.items.length === 0 && (
              <EmptyState
                title="No briefs yet"
                description="Write a brief, or accept a recommendation that creates one."
              />
            )}
            {briefs.isSuccess && briefs.data.items.length > 0 && (
              <ul className="flex flex-col gap-1" aria-label="Briefs">
                {briefs.data.items.map((b) => {
                  const chip = briefChip(b.state);
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        aria-pressed={b.id === briefId}
                        onClick={() => update({ brief: b.id, package: null })}
                        className={listButton(b.id === briefId)}
                        data-testid={`brief-${b.id}`}
                      >
                        <span className="font-medium">{b.message || b.audience || b.id}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={chip.tone}>{chip.label}</Badge>
                          {isSuggested(b) && (
                            <Badge tone="info" glyph={false}>
                              Suggested plan
                            </Badge>
                          )}
                          {briefGaps(b).length > 0 && <Badge tone="warning">Incomplete</Badge>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {!forbidden && (
              <CreateBriefForm
                brandId={brandId}
                campaignId={campaignId}
                channels={channels.data ?? []}
                onCreated={(id) => update({ brief: id, package: null })}
              />
            )}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {briefId ? (
            <BriefDetail
              key={briefId}
              brandId={brandId}
              briefId={briefId}
              channels={channelMap}
              packages={packages.data?.packages}
              packagesWindow={windowText}
              selectedPackageId={packageId}
              onSelectPackage={(id) => update({ package: id })}
            />
          ) : (
            <Panel title="Brief" data-testid="brief-detail">
              <EmptyState
                title="No brief selected"
                description="Choose a brief to accept it, see its packages and produce variants."
              />
            </Panel>
          )}
          {packages.isError && (
            <RequestError
              error={packages.error}
              onRetry={() => void packages.refetch()}
              title="Packages could not be loaded"
            />
          )}
          {packageId && (
            <PackageDetail
              key={packageId}
              companyId={companyId}
              brandId={brandId}
              contentPackageId={packageId}
              channels={channelMap}
            />
          )}
        </div>
      </div>
    </main>
  );
}
