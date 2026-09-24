import { useMemo, useState } from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Badge, Button, Panel, Skeleton, StatusBanner } from '@oremedia/ui';
import { ToastProvider } from '../../components/toast';
import { DecisionForm, ManifestSummary } from '../../features/review/request-detail';
import {
  REQUEST_STATE_CHIP,
  parsePortalFragment,
  staleReasonText,
  type PortalLink,
} from '../../features/review/review-attention';
import { toUiError } from '../../lib/errors';
import { createQueryClient } from '../../lib/query-client';
import { TRPCProvider, createClient, createOptionsProxy, useTRPC } from '../../lib/trpc';
import { useTheme } from '../../lib/theme';

/**
 * External reviewer surface (spec 5.6, 21.1). A separate build target on its own origin; the `rl_…` token arrives
 * in the URL fragment, is read once into memory and removed from the address bar. It is never written to
 * sessionStorage, localStorage or a cookie, and every request carries it as `Bearer rl_…` through a client made
 * here, not the app's. The reviewer sees only the frozen manifest of their one request and decides once.
 */
let linkOnce: PortalLink | null | undefined;
/** Reads the fragment exactly once per page load and removes it from the address bar and history entry. */
function readLinkOnce(): PortalLink | null {
  if (linkOnce !== undefined) return linkOnce;
  linkOnce = parsePortalFragment(window.location.hash);
  if (linkOnce) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return linkOnce;
}

export function ReviewPortalRoute({ standalone = false }: { standalone?: boolean }) {
  useTheme();
  const [link] = useState<PortalLink | null>(readLinkOnce);
  const runtime = useMemo(() => {
    const queryClient = createQueryClient();
    const client = createClient({ bearerToken: () => link?.token ?? null, pathname: () => '/review-portal' });
    return { queryClient, client, trpc: createOptionsProxy(client, queryClient) };
  }, [link]);

  return (
    <QueryClientProvider client={runtime.queryClient}>
      <TRPCProvider trpcClient={runtime.client} queryClient={runtime.queryClient}>
        <ToastProvider>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <main id="main" className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-4 p-4 sm:p-6">
            <h1 className="text-xl font-semibold">Oremedia review</h1>
            {!link ? (
              <StatusBanner
                tone="warning"
                title="This link is incomplete"
                description={
                  standalone
                    ? 'Open the review link exactly as it was sent to you; the part after # identifies your request. If it was cut off, ask the sender for the link again.'
                    : 'This route is served from the review portal origin in production. Open a review link exactly as it was sent.'
                }
              />
            ) : (
              <Portal link={link} />
            )}
          </main>
        </ToastProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
}

type Outcome = { kind: 'approve' | 'request_changes' };

/** The token is bound to one request server-side; the policy refuses any other id, so the link names its own. */
function useReviewerRequest(reviewRequestId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.review.requests.get.queryOptions({ reviewRequestId }), enabled, retry: false });
}

function Portal({ link }: { link: PortalLink }) {
  const expiredByClock = link.expiresAt !== null && new Date(link.expiresAt).getTime() < Date.now();
  const request = useReviewerRequest(link.reviewRequestId, !expiredByClock);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (expiredByClock) return <Expired expiresAt={link.expiresAt} />;
  if (request.isPending) return <Skeleton label="Loading your review" />;
  if (request.isError) {
    const ui = toUiError(request.error);
    if (ui.kind === 'forbidden')
      // The server says only that the link no longer grants access; whether it expired or was revoked is known
      // here only when the link carried its expiry, so the text claims no more than that.
      return link.expiresAt ? (
        <StatusBanner
          tone="critical"
          title="This link has been revoked"
          data-testid="portal-revoked"
          description="The brand team withdrew this reviewer link, so it no longer opens the request. If you still need to review, ask them for a new link."
        />
      ) : (
        <StatusBanner
          tone="critical"
          title="This link is no longer valid"
          data-testid="portal-invalid"
          description="It has expired or was revoked by the brand team. If you still need to review, ask them for a new link."
        />
      );
    if (ui.kind === 'sign_in' || ui.kind === 'not_found')
      return (
        <StatusBanner
          tone="critical"
          title="This link is not recognised"
          description="The token in this link does not match any reviewer link, or the request it names does not exist. Check that the whole link was copied."
        />
      );
    return (
      <StatusBanner
        tone="critical"
        title="The review could not be loaded"
        description={ui.message}
        actions={
          <Button size="sm" onClick={() => void request.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const r = request.data;
  const state = REQUEST_STATE_CHIP[r.state];
  return (
    <div className="flex flex-col gap-4">
      {outcome && (
        <StatusBanner
          tone="good"
          title={outcome.kind === 'approve' ? 'Thank you: approved' : 'Thank you: changes requested'}
          data-testid="portal-success"
          description="Your decision is recorded against exactly this manifest, with your verified email. This link cannot be used to decide again."
        />
      )}
      {!outcome && r.state === 'decided' && (
        <StatusBanner
          tone="info"
          title="This request has already been decided"
          data-testid="portal-decided"
          description="A decision was already recorded for this request, so nothing more can be done from this link. The frozen manifest is shown below for reference."
        />
      )}
      {r.state === 'stale' && (
        <StatusBanner
          tone="warning"
          title="This request is stale"
          data-testid="portal-stale"
          description={`The package changed after this manifest was frozen (${staleReasonText(r.staleReason)}), so it can no longer be decided. The brand team will send a new request for the current package.`}
        />
      )}
      {r.state === 'cancelled' && (
        <StatusBanner
          tone="neutral"
          title="This request was withdrawn"
          description="The brand team cancelled it; there is nothing to decide."
        />
      )}
      <Panel title="What you are reviewing">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={state.tone} data-testid="portal-state">
            {state.label}
          </Badge>
          {r.dueAt && <span className="text-muted-foreground">Due {new Date(r.dueAt).toLocaleString()}</span>}
        </div>
        <ManifestSummary manifest={r.frozenManifest} manifestHash={r.manifestHash} />
      </Panel>
      {!outcome && r.state === 'open' && (
        <Panel title="Your decision">
          <p className="mb-3 text-sm text-muted-foreground">
            You can decide once. Your email address is verified by this link and recorded with the decision.
          </p>
          <DecisionForm
            reviewRequestId={r.id}
            manifestHash={r.manifestHash}
            onDecided={(decision) => {
              setOutcome({ kind: decision === 'approve' ? 'approve' : 'request_changes' });
              void request.refetch();
            }}
          />
        </Panel>
      )}
    </div>
  );
}

function Expired({ expiresAt }: { expiresAt: string | null }) {
  return (
    <StatusBanner
      tone="warning"
      title="This link has expired"
      data-testid="portal-expired"
      description={`It stopped working on ${expiresAt ? new Date(expiresAt).toLocaleString() : 'its expiry date'}. Ask the brand team for a new link if the review is still needed.`}
    />
  );
}
