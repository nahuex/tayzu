/**
 * The identity change's telemetry contract as design.md's "Observability
 * contract" tables state it (043, task 15.1), written out once so that
 * `telemetry/identity-contract.test.ts` and `apps/api`'s
 * `otel-smoke-check.int.test.ts` assert the same thing. It is the spec side of
 * the comparison: nothing here is derived from `identity-contract.ts`.
 *
 * `catalog.security.authz_denied` and `tayzu.authz.decisions` are reused from
 * 001 / 002 and are not part of the identity module.
 */
const TENANT = 'tayzu.tenant.id';
const ACTOR_ID = 'tayzu.actor.id';
const ACTOR_TYPE = 'tayzu.actor.type';
const OPERATOR_ID = 'tayzu.identity.operator.id';
const USER_ID = 'tayzu.identity.user.id';
const INVITATION_ID = 'tayzu.identity.invitation.id';
const SERVICE_ACCOUNT_ID = 'tayzu.identity.service_account.id';

export interface ExpectedSpan {
  readonly name: string;
  readonly attributes: readonly string[];
}

export interface ExpectedMetric {
  readonly name: string;
  readonly attributes: readonly string[];
}

export interface ExpectedLogEvent {
  readonly name: string;
  readonly severity: 'INFO' | 'WARN';
  /** Required attributes, for an event that has a single form. */
  readonly attributes?: readonly string[];
  /** Required attributes per form, for an event that has several. */
  readonly forms?: Readonly<Record<string, readonly string[]>>;
  /** Attributes that a form may omit (declared, but absent in some writes). */
  readonly conditional?: readonly string[];
}

export const EXPECTED_SPANS: readonly ExpectedSpan[] = [
  {
    name: 'identity.invitation.create',
    attributes: [INVITATION_ID, 'tayzu.identity.invitation.role'],
  },
  { name: 'identity.invitation.accept', attributes: [INVITATION_ID] },
  {
    name: 'identity.invitation.cancel',
    attributes: [INVITATION_ID, 'tayzu.identity.invitation.reason'],
  },
  { name: 'identity.invitation.resend', attributes: [INVITATION_ID] },
  {
    name: 'identity.user.set_status',
    attributes: ['tayzu.identity.user.status.from', 'tayzu.identity.user.status.to'],
  },
  { name: 'identity.service_account.create', attributes: [SERVICE_ACCOUNT_ID] },
  { name: 'identity.service_account.delete', attributes: [SERVICE_ACCOUNT_ID] },
  { name: 'identity.credential.list', attributes: ['tayzu.identity.credential.count'] },
  { name: 'identity.credential.create', attributes: ['tayzu.identity.credential.kind'] },
  { name: 'identity.credential.rotate', attributes: ['tayzu.identity.credential.kind'] },
  { name: 'identity.credential.revoke', attributes: ['tayzu.identity.credential.kind'] },
  {
    name: 'identity.user.reconcile',
    attributes: [
      TENANT,
      OPERATOR_ID,
      'tayzu.identity.reconcile.created',
      'tayzu.identity.reconcile.orphans',
    ],
  },
];

export const EXPECTED_METRICS: readonly ExpectedMetric[] = [
  {
    name: 'tayzu.identity.invitations',
    attributes: [TENANT, 'tayzu.identity.invitation.mutation'],
  },
  {
    name: 'tayzu.identity.user_status_changes',
    attributes: [TENANT, 'tayzu.identity.user.status.to', ACTOR_TYPE],
  },
  {
    name: 'tayzu.identity.service_accounts',
    attributes: [TENANT, 'tayzu.identity.service_account.mutation'],
  },
  {
    name: 'tayzu.identity.credential_mutations',
    attributes: [TENANT, 'tayzu.identity.credential.kind', 'tayzu.identity.credential.mutation'],
  },
  {
    name: 'tayzu.identity.principal_rejections',
    attributes: ['tayzu.identity.rejection.reason', ACTOR_TYPE],
  },
];

const STATUS_TAIL = [
  'tayzu.identity.user.status.to',
  'tayzu.identity.user.status.event',
  'tayzu.identity.user.account_kind',
] as const;

export const EXPECTED_LOG_EVENTS: readonly ExpectedLogEvent[] = [
  {
    name: 'catalog.audit.invitation_created',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_TYPE, ACTOR_ID, INVITATION_ID, 'tayzu.identity.invitation.role'],
  },
  {
    name: 'catalog.audit.invitation_accepted',
    severity: 'INFO',
    attributes: [
      TENANT,
      ACTOR_TYPE,
      ACTOR_ID,
      INVITATION_ID,
      'tayzu.identity.invitation.role',
      USER_ID,
      'tayzu.identity.invitation.path',
    ],
  },
  {
    name: 'catalog.audit.invitation_cancelled',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, INVITATION_ID, 'tayzu.identity.invitation.reason'],
  },
  {
    name: 'catalog.audit.invitation_resent',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_TYPE, ACTOR_ID, INVITATION_ID],
  },
  {
    name: 'catalog.audit.user_created',
    severity: 'INFO',
    forms: {
      admin: [TENANT, ACTOR_ID, USER_ID, 'tayzu.identity.user.role', 'tayzu.identity.user.source'],
      bootstrap: [
        TENANT,
        OPERATOR_ID,
        USER_ID,
        'tayzu.identity.user.role',
        'tayzu.identity.user.source',
      ],
    },
  },
  {
    // Forms are the principal / subject variants of Q116, Q117 and Q126:
    // `actor` is the admin of a write, the user of a first sign-in or the invitee
    // of an acceptance; `operator` is the reconcile and the bootstrap; `ban_hook`
    // has no principal; `service_account` carries the `svc-…` id in place of the
    // user id; `invitation` is the `created_invited` write (an invited email may
    // have no Better Auth user yet). `status.from` is absent for a created row.
    name: 'catalog.audit.user_status_changed',
    severity: 'INFO',
    forms: {
      actor: [TENANT, ACTOR_ID, USER_ID, ...STATUS_TAIL],
      operator: [TENANT, OPERATOR_ID, USER_ID, ...STATUS_TAIL],
      ban_hook: [TENANT, USER_ID, ...STATUS_TAIL],
      service_account: [TENANT, ACTOR_ID, SERVICE_ACCOUNT_ID, ...STATUS_TAIL],
      invitation: [TENANT, ACTOR_ID, INVITATION_ID, ...STATUS_TAIL],
    },
    conditional: ['tayzu.identity.user.status.from'],
  },
  {
    name: 'catalog.audit.service_account_created',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, SERVICE_ACCOUNT_ID],
  },
  {
    name: 'catalog.audit.service_account_deleted',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, SERVICE_ACCOUNT_ID],
  },
  {
    name: 'catalog.audit.credential_created',
    severity: 'INFO',
    attributes: [
      TENANT,
      ACTOR_ID,
      'tayzu.identity.credential.id',
      'tayzu.identity.credential.kind',
    ],
  },
  {
    name: 'catalog.audit.credential_rotated',
    severity: 'INFO',
    attributes: [
      TENANT,
      ACTOR_ID,
      'tayzu.identity.credential.old_id',
      'tayzu.identity.credential.new_id',
    ],
  },
  {
    name: 'catalog.security.invitation_acceptance_denied',
    severity: 'WARN',
    attributes: [INVITATION_ID, 'tayzu.identity.invitation.denial_reason'],
  },
  {
    name: 'catalog.security.invitation_rate_limited',
    severity: 'WARN',
    attributes: [TENANT, 'tayzu.identity.invitation.limit_scope'],
  },
  {
    name: 'catalog.security.self_status_change_denied',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID],
  },
  {
    name: 'catalog.security.principal_rejected',
    severity: 'WARN',
    attributes: ['tayzu.identity.rejection.reason', ACTOR_TYPE],
  },
  {
    name: 'catalog.security.credential_revoked',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID, 'tayzu.identity.credential.id'],
  },
  {
    name: 'catalog.security.credential_rotation_incomplete',
    severity: 'WARN',
    attributes: [
      TENANT,
      ACTOR_ID,
      'tayzu.identity.credential.old_id',
      'tayzu.identity.credential.new_id',
    ],
  },
  {
    name: 'catalog.security.admin_notice_failed',
    severity: 'WARN',
    attributes: [TENANT],
  },
  {
    name: 'catalog.audit.users_reconciled',
    severity: 'INFO',
    attributes: [
      TENANT,
      OPERATOR_ID,
      'tayzu.identity.reconcile.created',
      'tayzu.identity.reconcile.orphans',
    ],
  },
  {
    name: 'catalog.security.notice_suppressed',
    severity: 'WARN',
    attributes: [
      TENANT,
      'tayzu.identity.notice.template',
      'tayzu.identity.notice.suppression',
      'tayzu.identity.notice.dropped',
    ],
  },
  {
    name: 'catalog.security.email_recipient_blocked',
    severity: 'WARN',
    attributes: ['tayzu.identity.email.template'],
  },
  {
    name: 'catalog.security.banned_sign_in_attempt',
    severity: 'WARN',
    attributes: [USER_ID, 'tayzu.identity.sign_in.channel'],
  },
  {
    name: 'catalog.security.email_tenant_blocked',
    severity: 'WARN',
    attributes: [TENANT, 'tayzu.identity.email.template'],
  },
  {
    name: 'catalog.security.sso_link_shed',
    severity: 'WARN',
    attributes: [TENANT, USER_ID, 'tayzu.identity.sso_link.path'],
  },
  {
    name: 'catalog.security.sso_link_marker_failed',
    severity: 'WARN',
    attributes: [USER_ID],
  },
  {
    name: 'catalog.security.invitation_accept_compensation_failed',
    severity: 'WARN',
    attributes: [INVITATION_ID],
  },
  {
    name: 'catalog.security.accepting_session_revocation_failed',
    severity: 'WARN',
    attributes: [TENANT, INVITATION_ID, USER_ID],
  },
  {
    name: 'catalog.security.identity_conflict_refused',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID, 'tayzu.identity.conflict.reason', USER_ID],
  },
];

/**
 * The closed value set of each bounded attribute (design tables), plus the
 * constants and the one value this change adds to `002`'s revocation reason.
 */
export const EXPECTED_ATTRIBUTE_VALUES: Readonly<Record<string, readonly string[]>> = {
  'tayzu.identity.invitation.role': ['member', 'admin'],
  'tayzu.identity.invitation.path': ['new_account', 'existing_account'],
  // The constant that stands for an id failing its shape or length check (D4).
  'tayzu.identity.invitation.id': ['invalid'],
  'tayzu.identity.invitation.reason': [
    'admin_cancel',
    're_invite',
    'user_disabled',
    'inviter_disabled',
    'user_created',
  ],
  'tayzu.identity.invitation.mutation': [
    'created',
    'accepted',
    'rejected',
    'cancelled',
    'expired',
    'rate_limited',
  ],
  'tayzu.identity.invitation.denial_reason': [
    'malformed_request',
    'expired',
    'cancelled',
    'rejected',
    'already_accepted',
    'token_mismatch',
    'disabled_user',
    'not_found',
    'session_required',
    'email_mismatch',
    'account_conflict',
    'csrf_rejected',
    'origin_rejected',
    'inviter_not_active_admin',
    'member_limit',
    'consume_conflict',
  ],
  'tayzu.identity.invitation.limit_scope': ['tenant', 'recipient', 'global'],
  'tayzu.identity.service_account.mutation': ['created', 'disabled', 'enabled', 'deleted'],
  'tayzu.identity.credential.kind': ['service_account', 'integration', 'agent'],
  'tayzu.identity.credential.mutation': ['created', 'rotated', 'revoked'],
  'tayzu.identity.rejection.reason': [
    'user_disabled',
    'user_banned',
    'service_account_disabled',
    'service_account_missing',
    'user_missing',
  ],
  'tayzu.identity.user.role': ['member', 'admin'],
  'tayzu.identity.user.source': ['admin', 'bootstrap'],
  'tayzu.identity.user.status.event': [
    'created_staged',
    'created_invited',
    'created_active',
    'invitation_accepted',
    'first_sign_in',
    'admin_disable',
    'admin_enable',
  ],
  'tayzu.identity.notice.template': ['admin_accepted'],
  'tayzu.identity.notice.suppression': ['global', 'tenant', 'recipient', 'truncated'],
  'tayzu.identity.email.template': ['invitation', 'admin_accepted'],
  'tayzu.identity.sign_in.channel': ['local', 'sso'],
  'tayzu.identity.sso_link.path': ['acceptance', 'membership_hook', 'reconcile'],
  'tayzu.identity.conflict.reason': [
    'account_exists',
    'target_in_other_tenant',
    'sub_already_linked',
    'target_is_admin_or_owner',
  ],
  // The value this change adds to 002's `auth.security.session_revoked` reason.
  'tayzu.auth.revocation.reason': ['sso_link_shed'],
};
