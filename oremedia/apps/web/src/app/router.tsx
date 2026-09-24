import type { QueryClient } from '@tanstack/react-query';
import { createBrowserRouter, redirect, type LoaderFunctionArgs } from 'react-router';
import type { Trpc } from '../lib/trpc';
import { RootLayout } from './root';
import { RouteErrorBoundary, NotFoundRoute } from './error';
import { SignInRoute } from './sign-in/route';
import { PortfolioRoute } from './portfolio/route';
import { CompanyRoute } from './c/$company/route';
import { BrandLayout } from './c/$company/b/$brand/layout';
import { BrandHomeRoute } from './c/$company/b/$brand/home/route';
import { BrandSystemRoute } from './c/$company/b/$brand/system/route';
import { AssetLibraryRoute } from './c/$company/b/$brand/assets/route';
import { StudioRoute } from './c/$company/b/$brand/studio/$doc/route';
import { CalendarRoute } from './c/$company/b/$brand/calendar/route';
import { ReviewInboxRoute } from './c/$company/b/$brand/review/route';
import { AgentRunsRoute } from './c/$company/b/$brand/agents/route';
import { PLACEHOLDER_ROUTES } from './c/$company/b/$brand/placeholders';
import { ReviewPortalRoute } from './review-portal/route';

export interface RouterDeps {
  trpc: Trpc;
  queryClient: QueryClient;
}

const param = (args: LoaderFunctionArgs, name: string): string => {
  const v = args.params[name];
  if (!v) throw new Response('Not found', { status: 404 });
  return v;
};

/**
 * Spec 21.1: React Router 7 data routers; company and brand identity are in the URL. Loaders prefetch into the
 * TanStack Query cache (the same query options the components use) so a deep link renders with data.
 */
export function createAppRouter({ trpc, queryClient }: RouterDeps) {
  const prefetch = <T,>(promise: Promise<T>) => promise.catch(() => null); // components render the error state
  return createBrowserRouter([
    {
      path: '/',
      Component: RootLayout,
      ErrorBoundary: RouteErrorBoundary,
      children: [
        { index: true, loader: () => redirect('/portfolio') },
        { path: 'sign-in', Component: SignInRoute },
        {
          path: 'portfolio',
          Component: PortfolioRoute,
          loader: () => prefetch(queryClient.ensureQueryData(trpc.access.listCompanies.queryOptions())),
        },
        {
          path: 'c/:company',
          Component: CompanyRoute,
          loader: (args) =>
            prefetch(
              queryClient.ensureQueryData(
                trpc.brand.list.queryOptions(undefined, {
                  trpc: { context: { tenantId: param(args, 'company') } },
                }),
              ),
            ),
        },
        {
          path: 'c/:company/b/:brand',
          Component: BrandLayout,
          loader: (args) =>
            prefetch(
              queryClient.ensureQueryData(
                trpc.brand.get.queryOptions(
                  { brandId: param(args, 'brand') },
                  { trpc: { context: { tenantId: param(args, 'company') } } },
                ),
              ),
            ),
          children: [
            { index: true, loader: () => redirect('home') },
            { path: 'home', Component: BrandHomeRoute },
            { path: 'system', Component: BrandSystemRoute },
            { path: 'assets', Component: AssetLibraryRoute },
            {
              path: 'studio/:doc',
              Component: StudioRoute,
              loader: (args) =>
                prefetch(
                  queryClient.ensureQueryData(
                    trpc.creative.documents.get.queryOptions(
                      { documentId: param(args, 'doc') },
                      { trpc: { context: { tenantId: param(args, 'company') } } },
                    ),
                  ),
                ),
            },
            { path: 'agents', Component: AgentRunsRoute },
            {
              path: 'calendar',
              Component: CalendarRoute,
              loader: (args) =>
                prefetch(
                  queryClient.ensureQueryData(
                    trpc.publishing.channels.list.queryOptions(
                      { brandId: param(args, 'brand') },
                      { trpc: { context: { tenantId: param(args, 'company') } } },
                    ),
                  ),
                ),
            },
            {
              path: 'review',
              Component: ReviewInboxRoute,
              loader: (args) =>
                prefetch(
                  queryClient.ensureQueryData(
                    trpc.review.inbox.list.queryOptions(
                      { brandId: param(args, 'brand'), page: { limit: 100 } },
                      { trpc: { context: { tenantId: param(args, 'company') } } },
                    ),
                  ),
                ),
            },
            ...PLACEHOLDER_ROUTES,
          ],
        },
        { path: 'review-portal/*', Component: ReviewPortalRoute },
        { path: '*', Component: NotFoundRoute },
      ],
    },
  ]);
}
