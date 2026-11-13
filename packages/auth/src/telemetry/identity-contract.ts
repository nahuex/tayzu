/**
 * The identity-lifecycle telemetry contract (043, Resolved decision Q74),
 * kept apart from `./contract.ts`, whose test requires it to equal the authz
 * contract's `auth.*` subset exactly. 13.3 declared the four `002` Q42 names
 * here and 15.1 declares the rest, as design.md's Observability contract
 * states them. `catalog.security.authz_denied` and `tayzu.authz.decisions`
 * are reused from 001 / 002 and are not declared here.
 */
export interface IdentitySpanDeclaration {
  readonly name: string;
  /** Required attributes. */
  readonly attributes: readonly string[];
  /** Attributes that a span may omit (set only once a step has run). */
  readonly conditional?: readonly string[];
}

export interface IdentityMetricDeclaration {
  readonly name: string;
  readonly attributes: readonly string[];
}

export interface IdentityLogEventDeclaration {
  readonly name: string;
  readonly severity: 'INFO' | 'WARN';
  /** Required attributes, for an event that has a single form. */
  readonly attributes?: readonly string[];
  /** Required attributes per form, keyed by the form's source or principal. */
  readonly forms?: Readonly<Record<string, readonly string[]>>;
  /** Attributes that a write may omit. */
  readonly conditional?: readonly string[];
}

const TENANT = 'tayzu.tenant.id';
const ACTOR_ID = 'tayzu.actor.id';
const ACTOR_TYPE = 'tayzu.actor.type';
const OPERATOR_ID = 'tayzu.identity.operator.id';
const USER_ID = 'tayzu.identity.user.id';
const INVITATION_ID = 'tayzu.identity.invitation.id';
const SERVICE_ACCOUNT_ID = 'tayzu.identity.service_account.id';
const CREDENTIAL_KIND = 'tayzu.identity.credential.kind';
const CREDENTIAL_ID = 'tayzu.identity.credential.id';
const CREDENTIAL_OLD_ID = 'tayzu.identity.credential.old_id';
const CREDENTIAL_NEW_ID = 'tayzu.identity.credential.new_id';
const INVITATION_ROLE = 'tayzu.identity.invitation.role';
const INVITATION_REASON = 'tayzu.identity.invitation.reason';
const STATUS_FROM = 'tayzu.identity.user.status.from';
const STATUS_TO = 'tayzu.identity.user.status.to';
const REJECTION_REASON = 'tayzu.identity.rejection.reason';
const EMAIL_TEMPLATE = 'tayzu.identity.email.template';
const RESET_MFA = 'tayzu.identity.reset.mfa';
const MFA_RESET_PATH = 'tayzu.identity.mfa_reset.path';
const SESSIONS_REVOKED = 'tayzu.identity.sessions.revoked';
const RECONCILE_CREATED = 'tayzu.identity.reconcile.created';
const RECONCILE_ORPHANS = 'tayzu.identity.reconcile.orphans';

const STATUS_TAIL = [
  STATUS_TO,
  'tayzu.identity.user.status.event',
  'tayzu.identity.user.account_kind',
] as const;

export const IDENTITY_SPANS: readonly IdentitySpanDeclaration[] = [
  { name: 'identity.invitation.create', attributes: [INVITATION_ID, INVITATION_ROLE] },
  { name: 'identity.invitation.accept', attributes: [INVITATION_ID] },
  { name: 'identity.invitation.cancel', attributes: [INVITATION_ID, INVITATION_REASON] },
  { name: 'identity.invitation.resend', attributes: [INVITATION_ID] },
  { name: 'identity.user.set_status', attributes: [STATUS_FROM, STATUS_TO] },
  { name: 'identity.service_account.create', attributes: [SERVICE_ACCOUNT_ID] },
  { name: 'identity.service_account.delete', attributes: [SERVICE_ACCOUNT_ID] },
  { name: 'identity.credential.list', attributes: ['tayzu.identity.credential.count'] },
  { name: 'identity.credential.create', attributes: [CREDENTIAL_KIND] },
  { name: 'identity.credential.rotate', attributes: [CREDENTIAL_KIND] },
  { name: 'identity.credential.revoke', attributes: [CREDENTIAL_KIND] },
  {
    name: 'identity.user.reconcile',
    attributes: [TENANT, OPERATOR_ID, RECONCILE_CREATED, RECONCILE_ORPHANS],
  },
  // 044 (design D15). The confirm span sets `reset.mfa` only once the factor step has run.
  { name: 'identity.password_reset.request', attributes: [] },
  {
    name: 'identity.password_reset.confirm',
    attributes: [],
    conditional: [RESET_MFA],
  },
  { name: 'identity.mfa.reset', attributes: [MFA_RESET_PATH] },
];

export const IDENTITY_METRICS: readonly IdentityMetricDeclaration[] = [
  {
    name: 'tayzu.identity.invitations',
    attributes: [TENANT, 'tayzu.identity.invitation.mutation'],
  },
  { name: 'tayzu.identity.user_status_changes', attributes: [TENANT, STATUS_TO, ACTOR_TYPE] },
  {
    name: 'tayzu.identity.service_accounts',
    attributes: [TENANT, 'tayzu.identity.service_account.mutation'],
  },
  {
    name: 'tayzu.identity.credential_mutations',
    attributes: [TENANT, CREDENTIAL_KIND, 'tayzu.identity.credential.mutation'],
  },
  { name: 'tayzu.identity.principal_rejections', attributes: [REJECTION_REASON, ACTOR_TYPE] },
  // 044 (design D15).
  {
    name: 'tayzu.identity.password_reset_requests',
    attributes: ['tayzu.identity.reset.request_outcome'],
  },
  {
    name: 'tayzu.identity.password_reset_confirms',
    attributes: ['tayzu.identity.reset.confirm_outcome'],
  },
  { name: 'tayzu.identity.mfa_resets', attributes: [TENANT, MFA_RESET_PATH] },
  {
    name: 'tayzu.identity.recovery_emails',
    attributes: [EMAIL_TEMPLATE, 'tayzu.identity.email.outcome'],
  },
];

export const IDENTITY_LOG_EVENTS: readonly IdentityLogEventDeclaration[] = [
  {
    name: 'catalog.audit.invitation_created',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_TYPE, ACTOR_ID, INVITATION_ID, INVITATION_ROLE],
  },
  {
    name: 'catalog.audit.invitation_accepted',
    severity: 'INFO',
    attributes: [
      TENANT,
      ACTOR_TYPE,
      ACTOR_ID,
      INVITATION_ID,
      INVITATION_ROLE,
      USER_ID,
      'tayzu.identity.invitation.path',
    ],
  },
  {
    name: 'catalog.audit.invitation_cancelled',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, INVITATION_ID, INVITATION_REASON],
  },
  {
    name: 'catalog.audit.invitation_resent',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_TYPE, ACTOR_ID, INVITATION_ID],
  },
  {
    // The `bootstrap` form carries the operator in place of the acting admin (Q116).
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
    // Forms are the principal / subject variants of Q116, Q117 and Q126.
    // `status.from` is absent for a created row.
    name: 'catalog.audit.user_status_changed',
    severity: 'INFO',
    forms: {
      actor: [TENANT, ACTOR_ID, USER_ID, ...STATUS_TAIL],
      operator: [TENANT, OPERATOR_ID, USER_ID, ...STATUS_TAIL],
      ban_hook: [TENANT, USER_ID, ...STATUS_TAIL],
      service_account: [TENANT, ACTOR_ID, SERVICE_ACCOUNT_ID, ...STATUS_TAIL],
      invitation: [TENANT, ACTOR_ID, INVITATION_ID, ...STATUS_TAIL],
    },
    conditional: [STATUS_FROM],
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
    attributes: [TENANT, ACTOR_ID, CREDENTIAL_ID, CREDENTIAL_KIND],
  },
  {
    name: 'catalog.audit.credential_rotated',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, CREDENTIAL_OLD_ID, CREDENTIAL_NEW_ID],
  },
  {
    name: 'catalog.audit.users_reconciled',
    severity: 'INFO',
    attributes: [TENANT, OPERATOR_ID, RECONCILE_CREATED, RECONCILE_ORPHANS],
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
    attributes: [REJECTION_REASON, ACTOR_TYPE],
  },
  {
    name: 'catalog.security.credential_revoked',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID, CREDENTIAL_ID],
  },
  {
    name: 'catalog.security.credential_rotation_incomplete',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID, CREDENTIAL_OLD_ID, CREDENTIAL_NEW_ID],
  },
  { name: 'catalog.security.admin_notice_failed', severity: 'WARN', attributes: [TENANT] },
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
    attributes: [EMAIL_TEMPLATE],
  },
  {
    name: 'catalog.security.banned_sign_in_attempt',
    severity: 'WARN',
    attributes: [USER_ID, 'tayzu.identity.sign_in.channel'],
  },
  {
    name: 'catalog.security.email_tenant_blocked',
    severity: 'WARN',
    attributes: [TENANT, EMAIL_TEMPLATE],
  },
  {
    name: 'catalog.security.sso_link_shed',
    severity: 'WARN',
    attributes: [TENANT, USER_ID, 'tayzu.identity.sso_link.path'],
  },
  { name: 'catalog.security.sso_link_marker_failed', severity: 'WARN', attributes: [USER_ID] },
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
  // 044 (design D15).
  { name: 'catalog.audit.password_reset_requested', severity: 'INFO', attributes: [USER_ID] },
  {
    name: 'catalog.audit.password_reset_completed',
    severity: 'INFO',
    attributes: [USER_ID, RESET_MFA, SESSIONS_REVOKED],
  },
  {
    name: 'catalog.audit.mfa_reset',
    severity: 'INFO',
    forms: {
      admin: [TENANT, ACTOR_ID, USER_ID, 'tayzu.identity.mfa_reset.reason', SESSIONS_REVOKED],
      operator: [TENANT, OPERATOR_ID, 'tayzu.identity.approver.id', USER_ID, SESSIONS_REVOKED],
    },
  },
  {
    name: 'catalog.security.password_reset_denied',
    severity: 'WARN',
    attributes: ['tayzu.identity.reset.denial_reason'],
    conditional: [USER_ID],
  },
  {
    name: 'catalog.security.recovery_email_suppressed',
    severity: 'WARN',
    attributes: [EMAIL_TEMPLATE, 'tayzu.identity.recovery.suppression'],
    conditional: [USER_ID],
  },
  {
    name: 'catalog.security.self_mfa_reset_denied',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID],
  },
];

/**
 * The closed value set of each bounded attribute, the constant `invalid` of
 * the invitation id (an id failing its shape or length check) and the value
 * this change adds to `002`'s `auth.security.session_revoked` reason.
 */
export const IDENTITY_ATTRIBUTE_VALUES: Readonly<Record<string, readonly string[]>> = {
  'tayzu.identity.invitation.role': ['member', 'admin'],
  'tayzu.identity.invitation.path': ['new_account', 'existing_account'],
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
  'tayzu.identity.email.template': [
    'invitation',
    'admin_accepted',
    'password_reset',
    'password_changed',
    'mfa_changed',
    'mfa_reset',
    'account_created',
  ],
  [RESET_MFA]: ['not_enrolled', 'totp', 'backup_code'],
  'tayzu.identity.reset.request_outcome': ['issued', 'ineligible', 'suppressed'],
  'tayzu.identity.reset.confirm_outcome': [
    'completed',
    'rejected',
    'factor_required',
    'policy_refused',
    'breach_check_unavailable',
  ],
  'tayzu.identity.reset.denial_reason': [
    'malformed_request',
    'csrf_rejected',
    'origin_rejected',
    'not_found',
    'expired',
    'token_mismatch',
    'not_eligible',
    'factor_invalid',
    'factor_state_inconsistent',
    'attempts_exhausted',
    'policy_violation',
    'breached',
    'breach_check_unavailable',
    'consume_conflict',
  ],
  'tayzu.identity.recovery.suppression': [
    'unknown_address',
    'no_credential_account',
    'banned',
    'disabled_everywhere',
    'no_membership',
    'kill_switch',
    'recipient_domain_blocked',
    'tenants_email_disabled',
    'recipient_cap',
    'ip_cap',
    'global_cap',
    'tenant_cap',
    'provider_failure',
    'token_issue_failure',
  ],
  [MFA_RESET_PATH]: ['admin', 'operator'],
  'tayzu.identity.mfa_reset.reason': [
    'lost_both_factors',
    'device_replaced',
    'suspected_compromise',
    'identity_verified_request',
  ],
  'tayzu.identity.email.outcome': ['sent', 'suppressed', 'failed'],
  'tayzu.identity.sign_in.channel': ['local', 'sso'],
  'tayzu.identity.sso_link.path': ['acceptance', 'membership_hook', 'reconcile'],
  'tayzu.identity.conflict.reason': [
    'account_exists',
    'target_in_other_tenant',
    'sub_already_linked',
    'target_is_admin_or_owner',
    'no_enrolled_factor',
  ],
  'tayzu.auth.revocation.reason': ['sso_link_shed', 'password_reset', 'mfa_reset'],
};
