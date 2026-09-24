import type { ApiScope, ApiScopeArea } from '@oremedia/contracts/access';

/**
 * Spec 7.6: the scope an API client key needs for a procedure, derived from the router map (spec 7.5) so a new
 * procedure is scoped the day it is added. Queries need `<area>:read`, mutations `<area>:write`. The longest
 * matching prefix wins (publishing.channels.* is `channels`, the rest of publishing is `publications`). Public REST
 * routes and MCP tools use the same vocabulary; a REST route's scope is the scope of the procedure it calls.
 */
const AREA_BY_PREFIX: ReadonlyArray<[prefix: string, area: ApiScopeArea]> = [
  ['publishing.channels.', 'channels'],
  ['publishing.', 'publications'],
  ['access.', 'access'],
  ['brand.', 'brands'],
  ['assets.', 'assets'],
  ['creative.', 'creative'],
  ['content.', 'content'],
  ['review.', 'review'],
  ['agents.', 'agents'],
  ['skills.', 'skills'],
  ['intelligence.', 'insights'],
  ['experiments.', 'experiments'],
  ['measurement.', 'measurement'],
  ['operations.', 'operations'],
];

export function scopeForProcedure(path: string, type: 'query' | 'mutation' | 'subscription'): ApiScope {
  const match = AREA_BY_PREFIX.find(([prefix]) => path.startsWith(prefix));
  // An unmapped router is a programming error (scopes.test.ts covers every procedure); it never falls open.
  if (!match) throw new Error(`no API scope area for procedure ${path}`);
  return `${match[1]}:${type === 'query' ? 'read' : 'write'}` as ApiScope;
}
