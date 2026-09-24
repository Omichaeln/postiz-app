import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { PolicyDeniedError } from '@oremedia/contracts/errors';

/**
 * Spec 12.7: tenant model-routing policy (permitted vendors, regions, retention, data classes), checked before
 * EVERY model call. The model id is configuration (MODEL_ROUTING_POLICY_REF / OREMEDIA_MODEL_ID), never a literal at
 * a call site.
 */
export const ModelVendor = z.enum(['anthropic', 'fake']);
export type ModelVendor = z.infer<typeof ModelVendor>;

export const ModelRoutingPolicy = z.object({
  schemaVersion: z.literal(1),
  defaultModel: z.string().min(1).max(120),
  permittedVendors: z.array(ModelVendor).min(1),
  /** Inference regions the tenant permits; [] = any region the vendor offers. */
  permittedRegions: z.array(z.string().max(40)).default([]),
  retention: z.enum(['zero', 'standard_30d']).default('standard_30d'),
  dataClasses: z.array(z.enum(['brand_content', 'customer_voice', 'pii'])).default(['brand_content']),
  deniedModels: z.array(z.string().max(120)).default([]),
});
export type ModelRoutingPolicy = z.infer<typeof ModelRoutingPolicy>;

/** Configuration default; overridden by MODEL_ROUTING_POLICY_REF / OREMEDIA_MODEL_ID (Appendix A). */
export const DEFAULT_MODEL_ID = 'claude-opus-5';

const builtIn = (): ModelRoutingPolicy =>
  ModelRoutingPolicy.parse({
    schemaVersion: 1,
    defaultModel: DEFAULT_MODEL_ID,
    permittedVendors: ['anthropic'],
  });

/**
 * MODEL_ROUTING_POLICY_REF names a JSON document mounted from the secret manager (a file path); when absent the
 * built-in policy applies with OREMEDIA_MODEL_ID as the default model.
 */
export function routingPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRoutingPolicy {
  const ref = env['MODEL_ROUTING_POLICY_REF'];
  const base =
    ref && existsSync(ref) ? ModelRoutingPolicy.parse(JSON.parse(readFileSync(ref, 'utf8'))) : builtIn();
  const modelId = env['OREMEDIA_MODEL_ID'];
  return modelId ? { ...base, defaultModel: modelId } : base;
}

let platformPolicy: ModelRoutingPolicy = builtIn();
/** Tests and the fake adapter run under a policy that permits the `fake` vendor. */
const tenantPolicies = new Map<string, ModelRoutingPolicy>();

/**
 * Tenant policies live in memory behind this source until a durable home exists: `tenants.policy` carries only
 * autonomy/MFA/approver settings and the schema is frozen for this phase (TODO: persist per tenant, spec 12.7).
 */
export type RoutingPolicySource = (tenantId: string) => Promise<ModelRoutingPolicy | null>;
let policySource: RoutingPolicySource = async (tenantId) => tenantPolicies.get(tenantId) ?? null;

export function configureRoutingPolicy(policy: ModelRoutingPolicy): void {
  platformPolicy = ModelRoutingPolicy.parse(policy);
}
export function setTenantRoutingPolicy(tenantId: string, policy: ModelRoutingPolicy | null): void {
  if (policy) tenantPolicies.set(tenantId, ModelRoutingPolicy.parse(policy));
  else tenantPolicies.delete(tenantId);
}
export function registerRoutingPolicySource(source: RoutingPolicySource): void {
  policySource = source;
}
/** Test seam. */
export function resetRoutingPolicies(): void {
  platformPolicy = builtIn();
  tenantPolicies.clear();
  policySource = async (tenantId) => tenantPolicies.get(tenantId) ?? null;
}

export async function routingPolicyFor(tenantId: string): Promise<ModelRoutingPolicy> {
  return (await policySource(tenantId)) ?? platformPolicy;
}

/** Throws FORBIDDEN(model_routing_denied) when the tenant's policy does not permit the vendor, model or region. */
export async function assertRoutingAllowed(
  tenantId: string,
  provider: string,
  model: string,
  region?: string,
): Promise<ModelRoutingPolicy> {
  const policy = await routingPolicyFor(tenantId);
  const vendor = ModelVendor.safeParse(provider);
  if (!vendor.success || !policy.permittedVendors.includes(vendor.data))
    throw new PolicyDeniedError(
      'model_routing_denied',
      `Model vendor ${provider} is not permitted for this company`,
    );
  if (policy.deniedModels.includes(model))
    throw new PolicyDeniedError('model_routing_denied', `Model ${model} is not permitted for this company`);
  if (region && policy.permittedRegions.length && !policy.permittedRegions.includes(region))
    throw new PolicyDeniedError('model_routing_denied', `Region ${region} is not permitted for this company`);
  return policy;
}
