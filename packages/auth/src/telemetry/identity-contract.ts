/**
 * The identity-lifecycle telemetry contract (043, Resolved decision Q74),
 * kept apart from `./contract.ts`, whose test requires it to equal the authz
 * contract's `auth.*` subset exactly. 13.3 declares the four `002` Q42 names
 * here and 15.1 the rest.
 */
export interface IdentityLogEventDeclaration {
  readonly name: string;
  /** Attributes the event carries in each form, keyed by the form's source. */
  readonly forms?: Readonly<Record<string, readonly string[]>>;
}

export const IDENTITY_SPANS: readonly string[] = [];
export const IDENTITY_METRICS: readonly string[] = [];
export const IDENTITY_LOG_EVENTS: readonly (string | IdentityLogEventDeclaration)[] = [
  {
    // The `bootstrap` form carries the operator in place of the acting admin (Q116).
    name: 'catalog.audit.user_created',
    forms: {
      admin: [
        'tayzu.tenant.id',
        'tayzu.actor.id',
        'tayzu.identity.user.id',
        'tayzu.identity.user.role',
        'tayzu.identity.user.source',
      ],
      bootstrap: [
        'tayzu.tenant.id',
        'tayzu.identity.operator.id',
        'tayzu.identity.user.id',
        'tayzu.identity.user.role',
        'tayzu.identity.user.source',
      ],
    },
  },
  'catalog.audit.credential_created',
  'catalog.audit.credential_rotated',
  'catalog.security.credential_revoked',
];
