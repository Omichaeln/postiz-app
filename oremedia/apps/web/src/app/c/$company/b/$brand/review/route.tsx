import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Panel, Skeleton } from '@oremedia/ui';
import { PageHeading, RequestError } from '../../../../../../components/request-state';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { useChannels, type ChannelDto } from '../../../../../../features/publishing/use-publishing';
import { RequestDetail } from '../../../../../../features/review/request-detail';
import {
  ATTENTION_CHIP,
  REQUEST_STATE_CHIP,
  orderAttention,
} from '../../../../../../features/review/review-attention';
import { useReviewInbox } from '../../../../../../features/review/use-review';
import { toUiError } from '../../../../../../lib/errors';

/**
 * Spec 21.1 review inbox: requests with the attention each needs (spec 21.2: changes requested, stale approval,
 * revoked external access), the frozen manifest, decisions for team reviewers and external reviewer links.
 */
export function ReviewInboxRoute() {
  const { brandId } = useBrandContext();
  const inbox = useReviewInbox(brandId);
  const channels = useChannels(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('request');
  const select = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('request', id);
    setParams(p, { replace: true });
  };

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <PageHeading
        title="Review inbox"
        description="Every request freezes exactly what reviewers see. A decision binds that manifest; anything that changes afterwards is shown here."
        actions={
          <Button size="sm" onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>
            {inbox.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Panel title="Requests">
          {inbox.isPending && <Skeleton label="Loading review requests" lines={4} />}
          {inbox.isError && (
            <RequestError
              error={inbox.error}
              onRetry={() => void inbox.refetch()}
              title={
                toUiError(inbox.error).kind === 'forbidden'
                  ? 'Restricted access: you cannot see this brand’s reviews'
                  : undefined
              }
            />
          )}
          {inbox.isSuccess && inbox.data.items.length === 0 && (
            <EmptyState
              title="No review requests"
              description="Requests appear here when a content package is sent for review."
            />
          )}
          {inbox.isSuccess && inbox.data.items.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Review requests" data-testid="inbox">
              {inbox.data.items.map((item) => {
                const state = REQUEST_STATE_CHIP[item.state];
                const selected = item.id === selectedId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => select(item.id)}
                      data-testid={`inbox-${item.id}`}
                      className={`flex w-full flex-col gap-1 rounded-md border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-accent bg-secondary' : 'border-border hover:bg-muted'}`}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone={state.tone} glyph={false}>
                          {state.label}
                        </Badge>
                        <code className="text-xs">{item.contentRevisionId}</code>
                        <span className="text-xs text-muted-foreground">
                          {new Date(item.createdAt).toLocaleDateString()}
                          {item.dueAt && ` · due ${new Date(item.dueAt).toLocaleDateString()}`}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {orderAttention(item.attention).map((flag) => (
                          <Badge
                            key={flag}
                            tone={ATTENTION_CHIP[flag].tone}
                            title={ATTENTION_CHIP[flag].detail}
                          >
                            {ATTENTION_CHIP[flag].label}
                          </Badge>
                        ))}
                        {item.externalLinks.total > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {item.externalLinks.total} external link
                            {item.externalLinks.total === 1 ? '' : 's'}
                            {item.externalLinks.revoked > 0 && ` (${item.externalLinks.revoked} revoked)`}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <RequestDetail reviewRequestId={selectedId} channels={channelMap} />
      </div>
    </main>
  );
}
