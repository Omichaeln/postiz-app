import { EmptyState } from '@oremedia/ui';

/**
 * External reviewer surface (spec 5.6, 21.1): a separate build target on its own origin. Reviewer links (`rl_…`
 * tokens) and the frozen review manifest arrive in Phase 5; until then the portal states that plainly.
 */
export function ReviewPortalRoute({ standalone = false }: { standalone?: boolean }) {
  return (
    <main id="main" className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center p-6">
      <h1 className="mb-4 text-xl font-semibold">Oremedia review</h1>
      <EmptyState
        title="The review portal arrives in Phase 5"
        description={
          standalone
            ? 'Review links open here once review requests, external reviewer links and frozen manifests exist. There is nothing to review yet.'
            : 'This route is served from the review portal origin in production. Review requests and external reviewer links arrive in Phase 5.'
        }
      />
    </main>
  );
}
