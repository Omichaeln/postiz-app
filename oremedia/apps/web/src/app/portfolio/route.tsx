import { Link } from 'react-router';
import { Badge, Button, EmptyState, Panel, Skeleton, StatusBanner } from '@oremedia/ui';
import { TopBar } from '../root';
import { PageHeading, RequestError } from '../../components/request-state';
import { useCompanies } from '../../features/portfolio/use-companies';

/** Spec 21.2 portfolio states: no memberships; restricted access; disconnected company or channel. */
export function PortfolioRoute() {
  const companies = useCompanies();
  return (
    <>
      <TopBar title="Portfolio" />
      <main id="main" className="mx-auto w-full max-w-4xl p-6">
        <PageHeading
          title="Your companies"
          description="Every company you are a member of. Company and brand are part of every link, and the server re-checks your membership on each request."
        />
        {companies.isPending && <Skeleton label="Loading companies" lines={4} />}
        {companies.isError && (
          <RequestError
            error={companies.error}
            onRetry={() => void companies.refetch()}
            title="Restricted access"
          />
        )}
        {companies.isSuccess && companies.data.length === 0 && (
          <EmptyState
            title="You are not a member of any company yet"
            description="Ask a company owner to invite you. Invitations are managed in each company's settings; nothing appears here until a membership is active."
          />
        )}
        {companies.isSuccess && companies.data.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="Companies">
            {companies.data.map((c) => (
              <li key={c.tenantId}>
                <Panel title={c.name} level={2} bodyClassName="flex items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <Badge glyph={false}>{c.role}</Badge>
                    <Badge glyph={false}>{c.allBrands ? 'All brands' : 'Selected brands'}</Badge>
                  </div>
                  <Button asChild variant="primary" size="sm">
                    <Link to={`/c/${encodeURIComponent(c.tenantId)}`}>Open</Link>
                  </Button>
                </Panel>
              </li>
            ))}
          </ul>
        )}
        <StatusBanner
          className="mt-6"
          tone="info"
          title="Overdue approvals, failed releases and channel health"
          description="These summaries arrive with review (Phase 5) and publishing (Phase 5); until then this page lists memberships only."
        />
      </main>
    </>
  );
}
