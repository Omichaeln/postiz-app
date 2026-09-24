import type { BrandSnapshot } from '@oremedia/contracts/brand';
import { EvaluationProperty, type SkillManifestV1 } from '@oremedia/contracts/skills';
import { validateJsonSchema } from './json-schema';

/** What one evaluation run produced and consumed; the checks are pure over it. */
export interface EvaluationRunTrace {
  output: unknown; // parsed final JSON, or null when the model produced none
  outputText: string;
  steps: number;
  tokens: number;
  toolCalls: Array<{ name: string; allowed: boolean }>;
}

/** The fixture a case runs against: the brand snapshot plus what eligibility and protection mean for it. */
export interface EvaluationBrandFixture {
  snapshot: BrandSnapshot;
  eligibleAssetIds: readonly string[];
  protectedElementIds: readonly string[];
}

export const DETERMINISTIC_CHECKS = EvaluationProperty.options;

export interface DeterministicResult {
  check: EvaluationProperty;
  passed: boolean;
  detail?: string;
}

const ASSET_ID = /\b(?:ast|av)_[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** Every string in a value, depth-first, for reference and term scanning. */
export function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out, depth + 1);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value as object)) stringsOf(v, out, depth + 1);
  return out;
}

/** Objects carrying `factId` / `factIds` / `factRefs` anywhere in the output are claims. */
function factRefsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) factRefsOf(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((k === 'factId' || k === 'fact_id') && typeof v === 'string') {
      out.push(v);
    } else if ((k === 'factIds' || k === 'factRefs' || k === 'fact_ids') && Array.isArray(v)) {
      for (const id of v) if (typeof id === 'string') out.push(id);
    } else {
      factRefsOf(v, out, depth + 1);
    }
  }
  return out;
}

/** Elements an output's operations target (`elementId` next to an `op`). */
function targetedElementIds(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) targetedElementIds(v, out, depth + 1);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['op'] === 'string' && typeof obj['elementId'] === 'string') out.push(obj['elementId']);
  for (const v of Object.values(obj)) targetedElementIds(v, out, depth + 1);
  return out;
}

/** Spec 19.6 deterministic checks, one per EvaluationProperty. A model-graded score never replaces any of them. */
export function runDeterministicChecks(
  manifest: SkillManifestV1,
  fixture: EvaluationBrandFixture,
  properties: readonly EvaluationProperty[],
  trace: EvaluationRunTrace,
): DeterministicResult[] {
  const { snapshot } = fixture;
  const output = trace.output;
  const strings = stringsOf(output);
  const eligible = new Set(fixture.eligibleAssetIds);
  const approvedFacts = new Set(snapshot.facts.map((f) => f.id));
  const protectedIds = new Set(fixture.protectedElementIds);
  const prohibited = [...snapshot.document.voice.prohibitedPhrases, ...snapshot.policy.prohibitedTerms]
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);
  const text = [trace.outputText, ...strings].join('\n').toLowerCase();
  const evaluate = (check: EvaluationProperty): DeterministicResult => {
    switch (check) {
      case 'schema_valid': {
        if (output === null) return { check, passed: false, detail: 'no JSON output' };
        const issues = validateJsonSchema(manifest.outputSchema, output);
        return issues.length
          ? {
              check,
              passed: false,
              detail: issues
                .map((i) => `${i.path || '$'}: ${i.issue}`)
                .join('; ')
                .slice(0, 2000),
            }
          : { check, passed: true };
      }
      case 'only_eligible_assets': {
        const bad = strings.flatMap((s) => s.match(ASSET_ID) ?? []).filter((id) => !eligible.has(id));
        return bad.length
          ? { check, passed: false, detail: `ineligible: ${[...new Set(bad)].join(', ')}` }
          : { check, passed: true };
      }
      case 'claims_reference_facts': {
        const claims = factRefsOf(output);
        if (claims.length === 0)
          return { check, passed: false, detail: 'no claim references an approved fact id' };
        const bad = claims.filter((id) => !approvedFacts.has(id));
        return bad.length
          ? { check, passed: false, detail: `unapproved facts: ${[...new Set(bad)].join(', ')}` }
          : { check, passed: true };
      }
      case 'no_prohibited_terms': {
        const hit = prohibited.filter((term) => text.includes(term));
        return hit.length
          ? { check, passed: false, detail: `prohibited: ${hit.join(', ')}` }
          : { check, passed: true };
      }
      case 'protected_elements_untouched': {
        const hit = targetedElementIds(output).filter((id) => protectedIds.has(id));
        return hit.length
          ? { check, passed: false, detail: `touched: ${[...new Set(hit)].join(', ')}` }
          : { check, passed: true };
      }
      case 'budget_respected': {
        const reasons: string[] = [];
        if (trace.steps > manifest.budgets.maxSteps)
          reasons.push(`steps ${trace.steps} > ${manifest.budgets.maxSteps}`);
        if (trace.tokens > manifest.budgets.maxTokens)
          reasons.push(`tokens ${trace.tokens} > ${manifest.budgets.maxTokens}`);
        const unlisted = trace.toolCalls.filter((c) => !c.allowed).map((c) => c.name);
        if (unlisted.length) reasons.push(`unlisted tools: ${[...new Set(unlisted)].join(', ')}`);
        return reasons.length
          ? { check, passed: false, detail: reasons.join('; ') }
          : { check, passed: true };
      }
    }
  };
  return properties.map(evaluate);
}
