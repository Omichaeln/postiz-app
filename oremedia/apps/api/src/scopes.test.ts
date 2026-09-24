import { describe, expect, it } from 'vitest';
import { ApiScope } from '@oremedia/contracts/access';
import { allProcedures } from './router';
import { scopeForProcedure } from './scopes';

describe('scopeForProcedure (spec 7.6 per-key scopes)', () => {
  it('maps every procedure of the router to a scope of the vocabulary: queries read, mutations write', () => {
    for (const { path, type } of allProcedures()) {
      const scope = scopeForProcedure(path, type);
      expect(ApiScope.options, path).toContain(scope);
      expect(scope.endsWith(type === 'query' ? ':read' : ':write'), path).toBe(true);
    }
  });

  it('uses the longest prefix: channels are their own area within publishing', () => {
    expect(scopeForProcedure('publishing.channels.list', 'query')).toBe('channels:read');
    expect(scopeForProcedure('publishing.publications.schedule', 'mutation')).toBe('publications:write');
    expect(scopeForProcedure('intelligence.insights.list', 'query')).toBe('insights:read');
    expect(scopeForProcedure('brand.get', 'query')).toBe('brands:read');
  });

  it('never falls open for a procedure outside the map', () => {
    expect(() => scopeForProcedure('unknown.thing', 'query')).toThrow(/no API scope area/);
  });
});
