import type { RestRouteSpec } from '../route';

/** Spec 7.6 brands: the brand router's list and get. */
export const BRAND_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'GET',
    path: '/v1/brands',
    procedure: 'brand.list',
    summary: 'List the brands the caller can see',
  },
  { method: 'GET', path: '/v1/brands/:brandId', procedure: 'brand.get', summary: 'Get a brand' },
];
