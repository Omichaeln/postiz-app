import { z } from 'zod';

/**
 * Spec 6.1: prefixed ULIDs, varchar(32). Prefix + '_' + 26 Crockford base32 chars ≤ 32.
 * Prefixes make ID mix-ups visible in logs and tests.
 */
export const ID_PREFIXES = {
  tenant: 'ten',
  user: 'usr',
  membership: 'mem',
  brandGrant: 'bg',
  servicePrincipal: 'sp',
  apiClient: 'ac',
  session: 'ses',
  externalReviewerLink: 'erl',
  supportSession: 'ss',
  brand: 'brd',
  brandVersion: 'bv',
  designTokenSet: 'tok',
  approvedFact: 'fact',
  brandObjective: 'obj',
  policyVersion: 'pol',
  asset: 'ast',
  assetVersion: 'av',
  assetDerivative: 'ad',
  usageRights: 'ur',
  assetGrant: 'ag',
  assetUsage: 'au',
  uploadIntent: 'ui',
  collection: 'col',
  creativeDocument: 'doc',
  creativeRevision: 'rev',
  renderedExport: 'exp',
  elementComment: 'cmt',
  template: 'tpl',
  templateVersion: 'tv',
  renderJob: 'rj',
  campaign: 'cmp',
  brief: 'brf',
  contentPackage: 'pkg',
  contentRevision: 'pr',
  channelVariant: 'cv',
  creativeAttributes: 'ca',
  reviewRequest: 'rr',
  reviewDecision: 'rd',
  releaseApproval: 'apr',
  publishingMandate: 'man',
  skill: 'skl',
  skillVersion: 'sv',
  skillBinding: 'sb',
  evaluationSuite: 'es',
  evaluationResult: 'er',
  agentRun: 'run',
  agentStep: 'step',
  toolInvocation: 'ti',
  channelConnection: 'cc',
  credentialRef: 'cr',
  publication: 'pub',
  publicationAttempt: 'att',
  remoteEvidence: 're',
  providerCapability: 'pc',
  metricDefinition: 'md',
  metricSnapshot: 'ms',
  trackedLink: 'tl',
  conversion: 'cnv',
  insight: 'ins',
  recommendation: 'rec',
  learningRecord: 'lrn',
  playbookEntry: 'pb',
  customerVoiceCluster: 'cvc',
  listeningSource: 'ls',
  anomaly: 'an',
  experiment: 'xp',
  experimentVariant: 'xv',
  experimentAssignment: 'xa',
  experimentResult: 'xr',
  conversation: 'conv',
  message: 'msg',
  communityAssignment: 'asg',
  responseDraft: 'rdft',
  plan: 'pln',
  entitlement: 'ent',
  subscription: 'sub',
  budgetReservation: 'br',
  usageLedger: 'ul',
  spendLimit: 'sl',
  auditEvent: 'aud',
  outboxEvent: 'evt',
  deletionRequest: 'dr',
  retentionPolicy: 'rp',
  incident: 'inc',
  killSwitch: 'ks',
  featureFlag: 'ff',
  element: 'el',
  externalRef: 'xref',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';

export const prefixedId = (kind: IdKind) =>
  z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_${ULID_BODY}$`), `expected ${kind} id`);

/** Any prefixed id (used where the resource type is dynamic, e.g. audit events). */
export const AnyId = z.string().regex(new RegExp(`^[a-z]{2,5}_${ULID_BODY}$`), 'expected prefixed ULID');

export const ElementId = prefixedId('element');

export const isIdOfKind = (kind: IdKind, value: string): boolean => prefixedId(kind).safeParse(value).success;
