import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import type { EvaluationCase, SkillManifestV1 } from '@oremedia/contracts/skills';
import { FakeModelAdapter, type FakeModelScript } from '../fake-adapter';
import { createReleaseOneRegistry } from '../tools';
import {
  DEFAULT_EVALUATION_FIXTURE_REF,
  defaultEvaluationFixture,
  evaluationBrandFixtures,
} from './fixtures';
import { validateJsonSchema } from './json-schema';
import { runEvaluation } from './run-evaluation';
import { mean, variance } from './stats';

const manifest: SkillManifestV1 = {
  schemaVersion: 1,
  key: 'brand-copywriting',
  title: 'Brand copywriting',
  description: 'captions',
  taskKinds: ['copywriting'],
  inputSchema: { type: 'object' },
  outputSchema: {
    type: 'object',
    required: ['variants'],
    properties: {
      variants: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['text', 'factIds'],
          properties: { text: { type: 'string' }, factIds: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    additionalProperties: false,
  },
  requiredContext: ['brand_snapshot', 'approved_facts'],
  allowedTools: ['facts.list'],
  budgets: { maxSteps: 4, maxTokens: 5000, maxCostMicros: 100000, maxVariants: 3, deadlineSeconds: 600 },
  modelCompatibility: [],
  instructionsPath: 'SKILL.md',
};
const fixture = defaultEvaluationFixture();
const factId = fixture.snapshot.facts[0]!.id;
const goodOutput = JSON.stringify({
  variants: [{ text: `Save 20% in October (${fixture.eligibleAssetIds[0]})`, factIds: [factId] }],
});

const evalCase = (over: Partial<EvaluationCase['expected']> = {}): EvaluationCase => ({
  id: 'case_1',
  title: 'October offer',
  input: { objective: 'announce the offer' },
  brandFixtureRef: DEFAULT_EVALUATION_FIXTURE_REF,
  expected: {
    properties: [
      'schema_valid',
      'only_eligible_assets',
      'claims_reference_facts',
      'no_prohibited_terms',
      'protected_elements_untouched',
      'budget_respected',
    ],
    rubric: [{ dimension: 'clarity', description: 'plain and specific', minScore: 6 }],
    ...over,
  },
});

const grader = (scores: number[]) => {
  let i = 0;
  return new FakeModelAdapter(() => ({
    kind: 'done',
    text: JSON.stringify({ scores: { clarity: scores[i++ % scores.length] } }),
  }));
};

const run = (script: FakeModelScript, g = grader([8, 6, 10]), c = evalCase(), runs = 3) =>
  runEvaluation({
    skillVersionId: 'sv_1',
    manifest,
    instructions: 'Write captions citing approved facts.',
    cases: [c],
    runs,
    adapter: new FakeModelAdapter(script),
    grader: g,
    brandFixtures: evaluationBrandFixtures(),
    registry: createReleaseOneRegistry(),
    model: 'fake-model',
    graderModel: 'fake-grader',
  });

describe('evaluation harness (spec 19.6)', () => {
  it('variance maths: population variance over the runs', () => {
    expect(mean([8, 6, 10])).toBe(8);
    expect(variance([8, 6, 10])).toBeCloseTo(8 / 3, 10);
    expect(variance([5, 5, 5])).toBe(0);
    expect(mean([])).toBe(0);
    expect(variance([])).toBe(0);
  });

  it('passes a clean output on every run and reports rubric mean and variance over three runs', async () => {
    const report = await run([
      { kind: 'tool_calls', toolCalls: [{ name: 'facts.list', arguments: {} }] },
      { kind: 'done', text: goodOutput },
    ]);
    expect(report.runs).toBe(3);
    expect(report.passed).toBe(true);
    expect(report.gradedBy).toEqual({ provider: 'fake', model: 'fake-grader' });
    const c = report.cases[0]!;
    expect(c.deterministic.every((d) => d.passed)).toBe(true);
    expect(c.rubric).toEqual([
      { dimension: 'clarity', mean: 8, variance: expect.closeTo(8 / 3, 10), scores: [8, 6, 10] },
    ]);
  });

  it('a model-graded score never overrides a deterministic failure (prohibited term, unapproved fact, ineligible asset)', async () => {
    const bad = JSON.stringify({
      variants: [{ text: 'Cheap deal! see av_01HN0TE1G1B1E0000000000000', factIds: ['fact_NOPE'] }],
    });
    const report = await run([{ kind: 'done', text: bad }], grader([10, 10, 10]));
    expect(report.passed).toBe(false);
    const failed = Object.fromEntries(report.cases[0]!.deterministic.map((d) => [d.check, d.passed]));
    expect(failed).toMatchObject({
      schema_valid: true,
      only_eligible_assets: false,
      claims_reference_facts: false,
      no_prohibited_terms: false,
    });
    expect(report.cases[0]!.rubric[0]!.mean).toBe(10);
  });

  it('a rubric below its minimum fails the case even when every deterministic check passes', async () => {
    const report = await run([{ kind: 'done', text: goodOutput }], grader([2, 3, 2]));
    expect(report.cases[0]!.deterministic.every((d) => d.passed)).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('calls to unlisted tools and protected elements fail budget_respected / protected_elements_untouched', async () => {
    const output = JSON.stringify({
      variants: [{ text: 'ok', factIds: [factId] }],
      operations: [{ op: 'moveElement', elementId: fixture.protectedElementIds[0], x: 1, y: 1 }],
    });
    const report = await run([
      { kind: 'tool_calls', toolCalls: [{ name: 'publications.publishNow', arguments: {} }] },
      { kind: 'done', text: output },
    ]);
    const checks = Object.fromEntries(report.cases[0]!.deterministic.map((d) => [d.check, d]));
    expect(checks['budget_respected']).toMatchObject({
      passed: false,
      detail: expect.stringContaining('publications.publishNow'),
    });
    expect(checks['protected_elements_untouched']?.passed).toBe(false);
  });

  it('requires at least three runs and a known brand fixture', async () => {
    await expect(run([{ kind: 'done', text: goodOutput }], undefined, undefined, 2)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      run(
        [{ kind: 'done', text: goodOutput }],
        undefined,
        evalCase() && { ...evalCase(), brandFixtureRef: 'nope' },
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('validates outputs against the manifest schema subset', () => {
    expect(validateJsonSchema(manifest.outputSchema, JSON.parse(goodOutput))).toEqual([]);
    expect(validateJsonSchema(manifest.outputSchema, { variants: [] }).map((i) => i.issue)).toEqual([
      'fewer than 1 items',
    ]);
    expect(
      validateJsonSchema(manifest.outputSchema, { variants: [{ text: 1 }], extra: true }).map((i) => i.path),
    ).toEqual(['variants[0].factIds', 'variants[0].text', 'extra']);
    expect(validateJsonSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null)).toEqual([]);
    expect(
      validateJsonSchema({ $ref: '#/definitions/x', definitions: { x: { enum: ['a'] } } }, 'b'),
    ).toHaveLength(1);
  });
});
