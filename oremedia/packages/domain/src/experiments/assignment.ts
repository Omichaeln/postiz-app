/**
 * Spec 16.6 hashed-visitor assignment and the per-tenant visitor hash. The one implementation lives in
 * @oremedia/contracts/visitor-assignment because the redirector (an app) may not import this package; modules keep
 * importing it from here.
 */
export { assignVariant, visitorHash, type AssignmentArm } from '@oremedia/contracts/visitor-assignment';
