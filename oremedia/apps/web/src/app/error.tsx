import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Button, EmptyState, StatusBanner } from '@oremedia/ui';

export function RouteErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundRoute />;
  const message =
    error instanceof Error ? error.message : 'An unexpected error occurred while rendering this page.';
  return (
    <main id="main" className="mx-auto w-full max-w-2xl p-6">
      <StatusBanner
        tone="critical"
        title="This page failed to render"
        description={message}
        actions={
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
    </main>
  );
}

export function NotFoundRoute() {
  return (
    <main id="main" className="mx-auto w-full max-w-2xl p-6">
      <EmptyState
        title="There is nothing at this address"
        description="Check the link, or go back to your portfolio."
        action={
          <Button asChild variant="primary">
            <Link to="/portfolio">Go to portfolio</Link>
          </Button>
        }
      />
    </main>
  );
}
