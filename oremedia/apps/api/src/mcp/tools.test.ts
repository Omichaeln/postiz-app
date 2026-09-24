import { describe, expect, it } from 'vitest';
import { assertNoExternalTools, createReleaseOneRegistry } from '@oremedia/ai';
import { listMcpTools } from './server';
import { MCP_TOOLS, createMcpRegistry } from './tools';

describe('MCP tool subset (spec 7.6)', () => {
  const registry = createMcpRegistry();

  it('exposes the eight curated tools, each registered and each with a scope matching its effect', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'brands.list',
      'assets.searchEligible',
      'content.createBrief',
      'agents.startRun',
      'creative.proposeOperations',
      'review.request',
      'publications.get',
      'insights.list',
    ]);
    for (const t of MCP_TOOLS) {
      const def = registry.get(t.name);
      expect(def, t.name).toBeDefined();
      expect(t.scope.endsWith(def?.effect === 'read' ? ':read' : ':write'), t.name).toBe(true);
    }
  });

  it('has no scheduling or publishing tool and nothing with an external effect (Postiz R2)', () => {
    assertNoExternalTools(registry);
    for (const t of MCP_TOOLS) {
      const def = registry.get(t.name);
      expect(def?.action.startsWith('publication.'), t.name).toBe(false);
      expect(t.name).not.toMatch(/schedul|publish/i);
    }
    // The agent-only proposal tool stays in the registry (so a call is denied and audited) but is never exposed.
    expect(registry.has('publications.proposeSchedule')).toBe(true);
    expect(MCP_TOOLS.some((t) => t.name === 'publications.proposeSchedule')).toBe(false);
  });

  it('keeps the whole Release 1 registry so every other name is known to the dispatcher', () => {
    for (const name of createReleaseOneRegistry().names()) expect(registry.has(name)).toBe(true);
  });

  it('tools/list serves the registry schema, adding the brand argument to brand-scoped tools', () => {
    const tools = listMcpTools(registry);
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      const exposure = MCP_TOOLS.find((t) => t.name === tool.name);
      const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      const own = registry.get(tool.name)?.inputSchema as { properties: Record<string, unknown> };
      for (const key of Object.keys(own.properties)) expect(schema.properties).toHaveProperty(key);
      expect('brandId' in schema.properties).toBe(exposure?.brandScoped);
      expect((schema.required ?? []).includes('brandId')).toBe(exposure?.brandScoped);
      expect(tool.annotations.readOnlyHint).toBe(registry.get(tool.name)?.effect === 'read');
    }
  });
});
