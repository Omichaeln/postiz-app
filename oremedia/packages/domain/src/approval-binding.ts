import { ApprovalBindingV1 } from '@oremedia/contracts/approval';
import { hashCanonical } from './hash';

export { ApprovalBindingV1 };

/** Spec 13.2: sha256(canonicalJson(binding)). Any change to any bound field changes the hash. */
export const bindingHash = (b: ApprovalBindingV1): string => hashCanonical(ApprovalBindingV1.parse(b));

export const withinTiming = (
  timing: ApprovalBindingV1['timing'],
  at: Date,
  exactToleranceMs = 15 * 60 * 1000,
): boolean => {
  if (timing.kind === 'exact') {
    return Math.abs(at.getTime() - Date.parse(timing.at)) <= exactToleranceMs;
  }
  return Date.parse(timing.from) <= at.getTime() && at.getTime() <= Date.parse(timing.to);
};
