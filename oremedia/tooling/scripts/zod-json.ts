import type { ZodTypeAny } from 'zod';

/**
 * Minimal Zod → JSON-schema-like projection sufficient for contract diffing (types, properties, required, enums,
 * arrays). Not a full JSON Schema generator; the public REST surface (Phase 5) uses trpc-to-openapi.
 */
export function zodToJsonSchema(schema: unknown): unknown {
  const s = schema as ZodTypeAny & { _def: Record<string, unknown> & { typeName?: string } };
  if (!s || typeof s !== 'object' || !('_def' in s)) return null;
  const def = s._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (def['shape'] as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        const inner = v._def as { typeName?: string };
        if (
          inner.typeName !== 'ZodOptional' &&
          inner.typeName !== 'ZodDefault' &&
          inner.typeName !== 'ZodNullable'
        )
          required.push(k);
      }
      return { type: 'object', properties, required };
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: def['value'] };
    case 'ZodEnum':
      return { type: 'string', enum: def['values'] };
    case 'ZodNativeEnum':
      return { type: 'string' };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def['type']) };
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodEffects':
    case 'ZodBranded':
    case 'ZodCatch':
      return zodToJsonSchema(def['innerType'] ?? def['schema'] ?? def['type']);
    case 'ZodUnion':
      return { anyOf: (def['options'] as ZodTypeAny[]).map(zodToJsonSchema) };
    case 'ZodDiscriminatedUnion':
      return {
        oneOf: [...(def['options'] as Map<unknown, ZodTypeAny> | ZodTypeAny[]).values()].map(zodToJsonSchema),
      };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def['valueType']) };
    case 'ZodLazy':
      return { $comment: 'recursive' };
    case 'ZodUnknown':
    case 'ZodAny':
      return {};
    default:
      return { $comment: def.typeName ?? 'unknown' };
  }
}
