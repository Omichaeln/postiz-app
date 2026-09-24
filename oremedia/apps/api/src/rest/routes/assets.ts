import type { RestRouteSpec } from '../route';

/** Spec 7.6 assets: eligibility search (spec 9.2; a read with a structured body, so POST) and get. */
export const ASSET_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'POST',
    path: '/v1/assets/search-eligible',
    procedure: 'assets.search',
    summary: 'Search approved, rights-cleared assets eligible for a purpose',
  },
  { method: 'GET', path: '/v1/assets/:assetId', procedure: 'assets.get', summary: 'Get an asset' },
];
