import type {
  EvaluationReport,
  SkillEvaluationActivitiesV1,
  SkillVersionState,
} from '@oremedia/contracts/skills';
import { withTransaction, type Tx } from '@oremedia/db';
import { logger } from '@oremedia/observability';
import { loadActorGrants } from './actor';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/**
 * Spec 10.2 / 19.6 activity for skillEvaluationWorkflowV1: establishes tenant context, runs the suite through the
 * skills module with no transaction open (the registered runner makes the model and grader calls), then records
 * the report in one short transaction. The store is the skills module's evaluation surface as the worker adapts it
 * (apps/worker-core wires skillsService.versions.runEvaluation / recordEvaluation), as render jobs do.
 */
export interface SkillEvaluationStore {
  /** The report is null when the version has already left the sandbox (nothing to run). */
  runEvaluation(input: {
    skillVersionId: string;
    suiteId: string;
    runs: number;
  }): Promise<{ skillVersionId: string; state: SkillVersionState; report: EvaluationReport | null }>;
  recordEvaluation(
    input: { skillVersionId: string; suiteId: string; report: EvaluationReport },
    tx: Tx,
  ): Promise<
    | {
        outcome: 'recorded';
        skillVersionId: string;
        suiteId: string;
        resultId: string;
        passed: boolean;
        state: SkillVersionState;
      }
    | { outcome: 'skipped'; skillVersionId: string; state: SkillVersionState }
  >;
  /** sandbox_evaluation → draft with no result row; a no-op when the version already left the sandbox. */
  failEvaluation(input: { skillVersionId: string; suiteId: string; reason: string }, tx: Tx): Promise<void>;
}

export interface SkillEvaluationDeps {
  store: SkillEvaluationStore;
  /** How often the activity heartbeats while the runner is busy (the runner has no hook of its own). */
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Spec 5.2: the requester's brand set as it is now. A platform operator's support session lives on the API request
 * and cannot be re-resolved from a worker; built-in skills are evaluated as platform work in the operator's
 * context as the API established it (every brand), and the write itself goes through the skills module's writer.
 */
export const loadSkillEvaluationGrants: GrantLoader = (input) =>
  input.actor.kind === 'platform_operator' ? Promise.resolve({ brandIds: 'all' }) : loadActorGrants(input);

export function createSkillEvaluationActivities(deps: SkillEvaluationDeps): SkillEvaluationActivitiesV1 {
  const log = () => logger().child('skill-evaluation');
  const intervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  return {
    runSkillEvaluation: async (input) => {
      try {
        return await inTenant(input, loadSkillEvaluationGrants, async () => {
          heartbeat('evaluate:run');
          const suite = { skillVersionId: input.skillVersionId, suiteId: input.suiteId, runs: input.runs };
          // The runner makes many bounded model calls; the heartbeat keeps the activity alive between them.
          const keepalive = setInterval(() => heartbeat('evaluate:running'), intervalMs);
          let run: Awaited<ReturnType<SkillEvaluationStore['runEvaluation']>>;
          try {
            run = await deps.store.runEvaluation(suite);
          } finally {
            clearInterval(keepalive);
          }
          const { report } = run;
          if (!report) {
            log().info({ skillVersionId: run.skillVersionId, state: run.state }, 'evaluation skipped');
            return { outcome: 'skipped', skillVersionId: run.skillVersionId, state: run.state };
          }
          heartbeat('evaluate:record');
          const recorded = await withTransaction((tx) =>
            deps.store.recordEvaluation({ ...suite, report }, tx),
          );
          log().info(
            { skillVersionId: input.skillVersionId, suiteId: input.suiteId, outcome: recorded.outcome },
            'evaluation recorded',
          );
          return recorded;
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },

    failSkillEvaluation: async (input) => {
      try {
        await inTenant(input, loadSkillEvaluationGrants, async () => {
          await withTransaction((tx) =>
            deps.store.failEvaluation(
              {
                skillVersionId: input.skillVersionId,
                suiteId: input.suiteId,
                reason: input.error.slice(0, 2000),
              },
              tx,
            ),
          );
          log().warn({ skillVersionId: input.skillVersionId, suiteId: input.suiteId }, 'evaluation failed');
        });
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
