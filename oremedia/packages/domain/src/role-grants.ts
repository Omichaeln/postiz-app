import type { Action } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';

/** Spec 5.5 default role grants (recommended default; tenants may customise within these bounds). */
const ALL: readonly MembershipRole[] = [
  'owner',
  'admin',
  'brand_manager',
  'creator',
  'reviewer',
  'publisher',
  'analyst',
  'community',
];
const ADMINS: readonly MembershipRole[] = ['owner', 'admin'];
const MANAGERS: readonly MembershipRole[] = ['owner', 'admin', 'brand_manager'];

export const DEFAULT_ROLE_GRANTS: Readonly<Record<Action, readonly MembershipRole[]>> = {
  'brand.read': ALL,
  'brand.edit_standards': MANAGERS,
  'brand.publish_version': MANAGERS,
  'asset.read': ALL,
  'asset.upload': [...MANAGERS, 'creator'],
  'asset.approve': MANAGERS,
  'asset.manage_rights': MANAGERS,
  'creative.read': ALL,
  'creative.edit': [...MANAGERS, 'creator'],
  'creative.render': [...MANAGERS, 'creator'],
  'content.plan': [...MANAGERS, 'creator'],
  'content.edit': [...MANAGERS, 'creator'],
  'review.request': [...MANAGERS, 'creator'],
  'review.decide': [...MANAGERS, 'reviewer'],
  'publication.schedule': [...MANAGERS, 'publisher'],
  'publication.cancel': [...MANAGERS, 'publisher'],
  'publication.delete_remote': [...ADMINS, 'publisher'],
  'channel.connect': [...ADMINS, 'publisher'],
  'channel.manage': [...ADMINS, 'publisher'],
  'mandate.manage': ADMINS,
  'agent.start_run': [...MANAGERS, 'creator', 'analyst'],
  'agent.cancel_run': [...MANAGERS, 'creator', 'analyst', 'publisher'],
  'skill.author': MANAGERS,
  'skill.publish': ADMINS,
  'insight.read': ALL,
  'experiment.manage': [...MANAGERS, 'analyst'],
  'playbook.approve': MANAGERS,
  'inbox.respond': [...MANAGERS, 'community'],
  'billing.manage': ADMINS,
  'membership.manage': ADMINS,
  'audit.read': ADMINS,
};

/** Actions an agent (service principal) may never perform, whatever its grants (spec 5.5 "Never"). */
export const AGENT_NEVER: ReadonlySet<Action> = new Set<Action>([
  'review.decide',
  'channel.connect',
  'channel.manage',
  'publication.delete_remote',
  'playbook.approve',
  'billing.manage',
  'membership.manage',
  'mandate.manage',
  'skill.publish',
  'audit.read',
]);

/** Actions where an agent may only propose (obligation propose_only). */
export const AGENT_PROPOSE_ONLY: ReadonlySet<Action> = new Set<Action>([
  'brand.edit_standards',
  'brand.publish_version',
  'asset.upload',
  'experiment.manage',
  'inbox.respond',
  'publication.schedule',
  'review.request',
]);

/** Read-only actions a platform operator support session may perform without escalation (spec 5.7). */
export const OPERATOR_READ_ONLY: ReadonlySet<Action> = new Set<Action>([
  'brand.read',
  'asset.read',
  'creative.read',
  'insight.read',
  'audit.read',
]);
