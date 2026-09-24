import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { servicePrincipals } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
// The agent tool registry and dispatcher live in @oremedia/ai, which this package does not depend on; the harness
// reaches them by path, as tooling/load does, and runs them with the sources the API composition registers.
import {
  createReleaseOneRegistry,
  defaultDispatchDeps,
  dispatchToolDetailed,
  type AgentRunContext,
} from '../../packages/ai/src/index';
import { AGENT_TOOL_INPUTS } from './src/inputs/agent-tools';
import { seedTwoTenants, type SeededTenant } from './src';

/** Denial reasons that prove the foreign id was never resolved: NOT_FOUND, or input validation before any lookup. */
const REJECTED = ['not_found', 'validation_failed'];

/**
 * Spec 19.3, agent tools: every registered Release 1 tool is dispatched through dispatchToolDetailed with tenant A's
 * run context (a principal granted every tool action, autonomy prepare_release) and tenant B's ids. The result must
 * be denied as not_found (or the input rejected before any lookup; read tools may instead return no data), and the
 * seed snapshot of tenant B must not change. A registered tool without a fixture fails.
 */
describe('cross-tenant harness: agent tools', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let run: AgentRunContext;
  const registry = createReleaseOneRegistry();
  const deps = defaultDispatchDeps(registry);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    const actions = [...new Set(registry.names().map((n) => registry.get(n)!.action))];
    const grants = actions.map((action) => ({
      action,
      brandIds: 'all' as const,
      channelConnectionIds: 'all' as const,
    }));
    const principal: ResolvedActorServicePrincipal = {
      kind: 'service_principal',
      id: newId('servicePrincipal'),
      tenantId: tenantA.tenantId,
      status: 'active',
      maxAutonomy: 'prepare_release',
      grants,
    };
    await tdb.db.insert(servicePrincipals).values({
      id: principal.id,
      tenantId: tenantA.tenantId,
      kind: 'agent',
      name: 'harness agent',
      grants,
      maxAutonomy: 'prepare_release',
      status: 'active',
      createdByUserId: tenantA.ownerUserId,
    });
    run = {
      runId: tenantA.ids['agentRunId']!,
      stepId: tenantA.ids['agentStepId']!,
      tenantId: tenantA.tenantId,
      brandId: tenantA.brandIds[0],
      correlationId: 'cross-tenant-agent-tools',
      tenantContext: {
        tenantId: tenantA.tenantId,
        actor: { kind: 'service_principal', id: principal.id },
        brandIds: 'all',
        correlationId: 'cross-tenant-agent-tools',
      },
      principal,
      policy: { autonomyMode: 'prepare_release', allowedTools: registry.names() },
      budgetReservationId: null,
      snapshot: null,
    };
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('every registered agent tool has a cross-tenant fixture (a new tool without one fails CI)', () => {
    const missing = registry.names().filter((name) => !(name in AGENT_TOOL_INPUTS));
    expect(
      missing,
      `add fixtures in tooling/test-fixtures/src/inputs/agent-tools.ts for: ${missing}`,
    ).toEqual([]);
    const stale = Object.keys(AGENT_TOOL_INPUTS).filter((name) => !registry.has(name));
    expect(stale, 'fixtures for tools that no longer exist').toEqual([]);
    for (const [name, fixture] of Object.entries(AGENT_TOOL_INPUTS))
      if (!fixture.buildArguments) expect(fixture.reason, `${name} needs a documented reason`).toBeTruthy();
  });

  it.each(
    createReleaseOneRegistry()
      .names()
      .map((name) => ({ name })),
  )('$name rejects foreign tenant resources', async ({ name }) => {
    const fixture = AGENT_TOOL_INPUTS[name];
    expect(fixture).toBeDefined();
    if (!fixture?.buildArguments) return; // documented: takes no resource ids
    const before = await tenantB.snapshot();
    const { result, record } = await dispatchToolDetailed(
      { id: `toolu_${name}`, name, arguments: fixture.buildArguments(tenantB.ids) },
      run,
      deps,
    );
    // the principal holds every action, so a denial here is the tool refusing the foreign id itself
    const rejected =
      result.kind === 'invalid' ||
      (result.kind === 'denied' && record.policyDecision === 'allowed' && REJECTED.includes(result.reason));
    if (fixture.knownGap)
      expect(rejected, `${name} is rejected now: remove its knownGap (${fixture.knownGap})`).toBe(false);
    else if (fixture.dataOf && result.kind === 'ok')
      expect(fixture.dataOf(result.output), `${name} returned data for foreign ids`).toEqual([]);
    else expect(rejected, `${name}: ${JSON.stringify(result)} (${record.policyReason})`).toBe(true);
    expect(await tenantB.snapshot()).toEqual(before); // no writes landed in tenant B
  });
});
