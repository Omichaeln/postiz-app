import type { RestRouteSpec } from '../route';

/** Spec 7.6 content: campaigns, briefs and packages (list, get, create). */
export const CONTENT_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'GET',
    path: '/v1/brands/:brandId/campaigns',
    procedure: 'content.campaigns.list',
    summary: 'List the campaigns of a brand',
  },
  {
    method: 'GET',
    path: '/v1/campaigns/:campaignId',
    procedure: 'content.campaigns.get',
    summary: 'Get a campaign',
  },
  {
    method: 'POST',
    path: '/v1/campaigns',
    procedure: 'content.campaigns.create',
    summary: 'Create a draft campaign',
    successStatus: 201,
  },
  {
    method: 'GET',
    path: '/v1/brands/:brandId/briefs',
    procedure: 'content.briefs.list',
    summary: 'List the briefs of a brand, optionally of one campaign',
  },
  { method: 'GET', path: '/v1/briefs/:briefId', procedure: 'content.briefs.get', summary: 'Get a brief' },
  {
    method: 'POST',
    path: '/v1/briefs',
    procedure: 'content.briefs.create',
    summary: 'Create a draft brief',
    successStatus: 201,
  },
  {
    method: 'GET',
    path: '/v1/brands/:brandId/packages',
    procedure: 'content.packages.list',
    summary: 'List the content packages of a brand',
  },
  {
    method: 'GET',
    path: '/v1/packages/:contentPackageId',
    procedure: 'content.packages.get',
    summary: 'Get a content package with its current revision and variants',
  },
  {
    method: 'POST',
    path: '/v1/packages',
    procedure: 'content.packages.create',
    summary: 'Create a content package (revision 1 as a draft)',
    successStatus: 201,
  },
];
