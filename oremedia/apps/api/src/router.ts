import { router } from './trpc';
import { accessRouter } from './routers/access';
import { operationsRouter } from './routers/operations';
import { brandRouter } from './routers/brand';
import { assetsRouter } from './routers/assets';
import { creativeRouter } from './routers/creative';
import { skillsRouter } from './routers/skills';
import { agentsRouter } from './routers/agents';

/** Spec 7.5 router map. Routers are added per phase; the cross-tenant harness enumerates every procedure. */
export const appRouter = router({
  access: accessRouter,
  brand: brandRouter,
  assets: assetsRouter,
  creative: creativeRouter,
  skills: skillsRouter,
  agents: agentsRouter,
  operations: operationsRouter,
});
export type AppRouter = typeof appRouter;

/** Every procedure path with its type, generated from the router definition (spec 19.3 allProcedures). */
export function allProcedures(): Array<{ path: string; type: 'query' | 'mutation' | 'subscription' }> {
  const procs = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: 'query' | 'mutation' | 'subscription' } }
  >;
  return Object.entries(procs).map(([path, p]) => ({ path, type: p._def.type }));
}
