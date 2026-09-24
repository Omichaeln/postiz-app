import { describe, expect, it } from 'vitest';
import { PAGE_DEFAULT, PAGE_MAX } from '@oremedia/contracts/pagination';
import { scopeForProcedure } from '../scopes';
import { clampPage, inputFor, resolveRoute, restRequestFor } from './route';
import { REST_ROUTE_SPECS, allRestRoutes } from './router';

describe('public REST route table (spec 7.6)', () => {
  it('binds every route to an existing procedure; a route has the scope of its procedure', () => {
    const routes = allRestRoutes();
    expect(routes).toHaveLength(REST_ROUTE_SPECS.length);
    for (const r of routes) {
      expect(r.scope).toBe(scopeForProcedure(r.procedure, r.type));
      expect(r.path.startsWith('/v1/')).toBe(true);
      // Path parameters are fields of the procedure input.
      const shape = (r.input as { shape?: Record<string, unknown> } | null)?.shape ?? {};
      for (const p of r.pathParams) expect(Object.keys(shape), `${r.path}: ${p}`).toContain(p);
    }
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses a route to a missing procedure and a mutation behind GET', () => {
    expect(() =>
      resolveRoute({ method: 'GET', path: '/v1/x', procedure: 'nope.nothing', summary: '' }),
    ).toThrow();
    expect(() =>
      resolveRoute({
        method: 'GET',
        path: '/v1/campaigns',
        procedure: 'content.campaigns.create',
        summary: '',
      }),
    ).toThrow(/never served by GET/);
  });

  it('clamps page limits into [1, 200] with the default for junk (spec 7.4)', () => {
    expect(clampPage('5000', undefined)).toEqual({ limit: PAGE_MAX });
    expect(clampPage(0, undefined)).toEqual({ limit: 1 });
    expect(clampPage('-3', undefined)).toEqual({ limit: 1 });
    expect(clampPage('abc', undefined)).toEqual({ limit: PAGE_DEFAULT });
    expect(clampPage(undefined, 'c1')).toEqual({ limit: PAGE_DEFAULT, cursor: 'c1' });
    expect(clampPage(12.7, '')).toEqual({ limit: 12 });
  });

  it('builds the procedure input from path, query and body; path parameters win', () => {
    const routes = allRestRoutes();
    const list = routes.find((r) => r.procedure === 'content.briefs.list');
    const create = routes.find((r) => r.procedure === 'content.briefs.create');
    const search = routes.find((r) => r.procedure === 'assets.search');
    if (!list || !create || !search) throw new Error('routes missing');
    expect(
      inputFor(list, {
        params: { brandId: 'brd_1' },
        query: { campaignId: 'cmp_1', limit: '999', cursor: 'abc', brandId: 'brd_other', unknown: 'x' },
        body: undefined,
      }),
    ).toEqual({ brandId: 'brd_1', campaignId: 'cmp_1', page: { limit: 200, cursor: 'abc' } });
    expect(inputFor(create, { params: {}, query: {}, body: { brandId: 'brd_1', audience: 'a' } })).toEqual({
      brandId: 'brd_1',
      audience: 'a',
    });
    expect(inputFor(search, { params: {}, query: {}, body: { query: { brandId: 'b' } } })).toEqual({
      query: { brandId: 'b' },
      page: { limit: PAGE_DEFAULT },
    });
  });

  it('restRequestFor is the inverse of inputFor for every route', () => {
    const samples: Record<string, unknown> = {
      brandId: 'brd_1',
      assetId: 'ast_1',
      campaignId: 'cmp_1',
      briefId: 'brf_1',
      contentPackageId: 'pkg_1',
      reviewRequestId: 'rr_1',
      publicationId: 'pub_1',
      runId: 'run_1',
    };
    for (const route of allRestRoutes()) {
      const input: Record<string, unknown> = {};
      for (const p of route.pathParams) input[p] = samples[p];
      const shape = (route.input as { shape?: Record<string, unknown> } | null)?.shape ?? {};
      if ('page' in shape) input['page'] = { limit: 10 };
      const req = restRequestFor(route, input);
      expect(req.url.includes(':'), req.url).toBe(false);
      expect(inputFor(route, req), route.path).toEqual(route.input ? input : undefined);
    }
  });
});
