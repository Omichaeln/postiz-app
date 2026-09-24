import { z } from 'zod';
import type { ModelMessage, ModelToolCall } from '@oremedia/contracts/agents';
import { BrandSnapshotV1 } from '@oremedia/contracts/brand';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import {
  EvaluationCase,
  EVALUATION_RUNS_MIN,
  SkillManifestV1,
  type EvaluationReport,
  type ResolvedSkill,
} from '@oremedia/contracts/skills';
import { hashCanonical } from '@oremedia/domain/hash';
import { DEFAULT_RUN_BUDGET, type ContextSnapshot } from '../context-resolver';
import type { ModelAdapter } from '../model-adapter';
import { assembleSystemPrompt, initialUserMessage } from '../prompt';
import type { ToolRegistry } from '../tool-registry';
import { runDeterministicChecks, type EvaluationBrandFixture, type EvaluationRunTrace } from './checks';
import { mean, variance } from './stats';

/** What a suite run needs beyond the suite itself. */
export interface EvaluationDeps {
  adapter: ModelAdapter;
  /** A separate adapter/model grades the rubric; deterministic failures always win over its scores. */
  grader: ModelAdapter;
  brandFixtures: Record<string, EvaluationBrandFixture>;
  registry: ToolRegistry;
  model: string;
  graderModel: string;
  now?: () => Date;
}

export interface EvaluationSuiteInput {
  skillVersionId: string;
  manifest: SkillManifestV1;
  instructions: string;
  cases: EvaluationCase[];
  /** ≥ 3 (spec 19.6); fewer is rejected. */
  runs: number;
}

export type EvaluationInput = EvaluationDeps & EvaluationSuiteInput;

/** The shape @oremedia/module-skills' registerEvaluationRunner accepts. */
export type EvaluationRunner = (suite: EvaluationSuiteInput) => Promise<EvaluationReport>;

const GraderResponse = z.object({ scores: z.record(z.number().min(0).max(10)) });

export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** A sandbox context: the fixture brand, the skill under test and only those of its allowed tools that exist. */
function sandboxSnapshot(input: EvaluationInput, fixture: EvaluationBrandFixture): ContextSnapshot {
  const brand = fixture.snapshot;
  const skill: ResolvedSkill = {
    skillVersionId: input.skillVersionId,
    skillId: `skill:${input.manifest.key}`,
    key: input.manifest.key,
    versionNumber: 0,
    manifest: input.manifest,
    instructions: input.instructions,
    references: [],
  };
  const allowedTools = input.registry.names().filter((n) => input.manifest.allowedTools.includes(n));
  const bundle: Omit<ContextSnapshot, 'hash'> = {
    tenantId: 'ten_evaluation',
    brandId: brand.brandId,
    brand,
    skills: [skill],
    eligibleAssets: fixture.eligibleAssetIds.map((assetVersionId) => ({
      assetId: assetVersionId,
      assetVersionId,
      kind: 'photo',
      semanticRole: null,
      altText: null,
      contentHash: '',
      width: null,
      height: null,
    })),
    facts: brand.facts.map((f) => ({ id: f.id, kind: f.kind, statement: f.statement })),
    playbook: [],
    evidence: [],
    policy: {
      autonomyMode: 'create',
      allowedTools,
      budget: { ...DEFAULT_RUN_BUDGET, ...input.manifest.budgets },
    },
    findings: [],
  };
  return { ...bundle, hash: hashCanonical(bundle) };
}

/**
 * One sandbox run: the real prompt assembly and tool schemas, the adapter's turns, tool calls recorded but never
 * executed (an evaluation has no tenant), until the model answers without tools or the step budget ends.
 */
async function runOnce(
  input: EvaluationInput,
  snapshot: ContextSnapshot,
  evalCase: EvaluationCase,
): Promise<EvaluationRunTrace> {
  const taskKind = input.manifest.taskKinds[0] ?? 'copywriting';
  const prompt = { snapshot, taskKind, brief: evalCase.input };
  const system = assembleSystemPrompt(prompt);
  const messages: ModelMessage[] = [
    { role: 'user', content: [{ type: 'text', text: initialUserMessage(prompt) }] },
  ];
  const tools = input.registry.schemasFor(snapshot.policy.allowedTools);
  const trace: EvaluationRunTrace = { output: null, outputText: '', steps: 0, tokens: 0, toolCalls: [] };
  for (let step = 0; step <= input.manifest.budgets.maxSteps; step++) {
    const completion = await input.adapter.complete({
      model: input.model,
      system,
      messages,
      tools,
      maxOutputTokens: 4096,
      timeoutMs: 120_000,
      metadata: { runId: `eval:${evalCase.id}`, tenantId: snapshot.tenantId },
    });
    trace.steps += 1;
    trace.tokens += completion.usage.inputTokens + completion.usage.outputTokens;
    const text = completion.content.map((c) => c.text).join('\n');
    if (completion.toolCalls.length === 0) {
      trace.outputText = text;
      trace.output = parseJsonOutput(text);
      return trace;
    }
    messages.push({
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...completion.toolCalls.map((c: ModelToolCall) => ({
          type: 'tool_use' as const,
          id: c.id,
          name: c.name,
          input: c.arguments,
        })),
      ],
    });
    for (const call of completion.toolCalls) {
      const allowed = snapshot.policy.allowedTools.includes(call.name);
      trace.toolCalls.push({ name: call.name, allowed });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: call.id,
            content: JSON.stringify(
              allowed
                ? {
                    kind: 'sandbox',
                    note: 'tools are not executed during evaluation; continue with the brief',
                  }
                : { kind: 'denied', reason: 'tool_not_allowed' },
            ),
            isError: !allowed,
          },
        ],
      });
    }
  }
  return trace;
}

/** Rubric grading by a separate model call: 0..10 per dimension, 0 when the grader's reply is unusable. */
async function grade(
  input: EvaluationInput,
  evalCase: EvaluationCase,
  trace: EvaluationRunTrace,
): Promise<Record<string, number>> {
  const rubric = evalCase.expected.rubric ?? [];
  if (rubric.length === 0) return {};
  const completion = await input.grader.complete({
    model: input.graderModel,
    system:
      'You grade an agent output against rubric dimensions, each described below. Reply with JSON only: ' +
      '{"scores": {"<dimension>": <0..10>}}. You do not decide permissions, rights or facts; those are checked ' +
      'deterministically elsewhere.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rubric: rubric.map((r) => ({ dimension: r.dimension, description: r.description })),
              brief: evalCase.input,
              output: trace.output ?? trace.outputText,
            }),
          },
        ],
      },
    ],
    tools: [],
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
    metadata: { runId: `eval-grade:${evalCase.id}`, tenantId: 'ten_evaluation' },
  });
  const parsed = GraderResponse.safeParse(parseJsonOutput(completion.content.map((c) => c.text).join('\n')));
  const scores: Record<string, number> = {};
  for (const r of rubric) scores[r.dimension] = parsed.success ? (parsed.data.scores[r.dimension] ?? 0) : 0;
  return scores;
}

/**
 * Spec 19.6: per case, the deterministic properties the case expects (over every run) plus rubric grading by a
 * separate model call reported with mean and variance over at least three runs. A case passes only when every
 * deterministic check passed in every run and every rubric mean reaches its minimum; a rubric score can fail a case
 * but never rescues a deterministic failure.
 */
export async function runEvaluation(input: EvaluationInput): Promise<EvaluationReport> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const manifest = SkillManifestV1.parse(input.manifest);
  if (input.runs < EVALUATION_RUNS_MIN)
    throw new ValidationFailedError([
      { path: 'runs', issue: `at least ${EVALUATION_RUNS_MIN} runs are required` },
    ]);
  const cases = input.cases.map((c) => EvaluationCase.parse(c));
  const report: EvaluationReport['cases'] = [];
  for (const evalCase of cases) {
    const fixture = input.brandFixtures[evalCase.brandFixtureRef];
    if (!fixture)
      throw new ValidationFailedError([
        { path: `cases.${evalCase.id}.brandFixtureRef`, issue: 'unknown brand fixture' },
      ]);
    const snapshot = sandboxSnapshot(
      { ...input, manifest },
      { ...fixture, snapshot: BrandSnapshotV1.parse(fixture.snapshot) },
    );
    const runs: Array<{
      deterministic: ReturnType<typeof runDeterministicChecks>;
      scores: Record<string, number>;
    }> = [];
    for (let i = 0; i < input.runs; i++) {
      const trace = await runOnce({ ...input, manifest }, snapshot, evalCase);
      runs.push({
        deterministic: runDeterministicChecks(manifest, fixture, evalCase.expected.properties, trace),
        scores: await grade(input, evalCase, trace),
      });
    }
    const deterministic = evalCase.expected.properties.map((check) => {
      const failed = runs
        .map((r) => r.deterministic.find((d) => d.check === check))
        .filter((d) => d && !d.passed);
      const first = failed[0];
      return first
        ? { check, passed: false, ...(first.detail ? { detail: first.detail } : {}) }
        : { check, passed: true };
    });
    const rubric = (evalCase.expected.rubric ?? []).map((r) => {
      const scores = runs.map((run) => run.scores[r.dimension] ?? 0);
      return { dimension: r.dimension, mean: mean(scores), variance: variance(scores), scores };
    });
    const rubricOk = (evalCase.expected.rubric ?? []).every(
      (r) => (rubric.find((s) => s.dimension === r.dimension)?.mean ?? 0) >= r.minScore,
    );
    report.push({
      caseId: evalCase.id,
      deterministic,
      rubric,
      passed: deterministic.every((d) => d.passed) && rubricOk,
    });
  }
  return {
    skillVersionId: input.skillVersionId,
    runs: input.runs,
    cases: report,
    passed: report.every((c) => c.passed),
    gradedBy: { provider: input.grader.provider, model: input.graderModel },
    startedAt,
    finishedAt: now().toISOString(),
  };
}

/** Binds the deployment's adapters, fixtures and registry; the result is what skillsService.registerEvaluationRunner takes. */
export function createEvaluationRunner(deps: EvaluationDeps): EvaluationRunner {
  return (suite) => runEvaluation({ ...deps, ...suite });
}
