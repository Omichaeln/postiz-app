import type { RestRouteSpec } from '../route';

/** Spec 7.6 intelligence reads (spec 16): insights and recommendations of a brand. */
export const INSIGHT_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'GET',
    path: '/v1/brands/:brandId/insights',
    procedure: 'intelligence.insights.list',
    summary: 'List the insights of a brand',
  },
  {
    method: 'GET',
    path: '/v1/brands/:brandId/recommendations',
    procedure: 'intelligence.recommendations.list',
    summary: 'List the recommendations of a brand',
  },
];
