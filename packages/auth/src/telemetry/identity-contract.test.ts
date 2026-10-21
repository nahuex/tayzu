/**
 * Task 13.3 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (Resolved
 * decision Q74; `002` Q42): the user, credential and bootstrap lifecycle events
 * are declared in the separate identity contract module, before any route
 * mounts them.
 *
 * Verify clause: "`identity-contract.test.ts` ... asserts the four names are
 * declared in the module, with both forms of `catalog.audit.user_created`."
 *
 * Design, log events table: `catalog.audit.user_created` carries
 * `tayzu.actor.id` (the admin) for the source `admin`, and
 * `tayzu.identity.operator.id` in its place for the source `bootstrap`
 * (Resolved decision Q116).
 *
 * ## Production symbols expected
 *
 * `IDENTITY_LOG_EVENTS` (`./identity-contract.js`) lists the four names
 * `catalog.audit.user_created`, `catalog.audit.credential_created`,
 * `catalog.audit.credential_rotated` and `catalog.security.credential_revoked`.
 * An entry is either the bare name or an object with a `name` field. The entry
 * of `catalog.audit.user_created` must describe both forms, so a bare string
 * cannot express it: it is an object that names `tayzu.actor.id`,
 * `tayzu.identity.operator.id` and the two sources `admin` and `bootstrap`.
 *
 * ## Why this fails right now
 *
 * `IDENTITY_LOG_EVENTS` is empty (assertion failure).
 */
import { describe, expect, it } from 'vitest';

import {
  EXPECTED_ATTRIBUTE_VALUES,
  EXPECTED_LOG_EVENTS,
  EXPECTED_METRICS,
  EXPECTED_SPANS,
} from '../__fixtures__/identity-contract-expected.js';
import * as identityContract from './identity-contract.js';
import { IDENTITY_LOG_EVENTS } from './identity-contract.js';

function nameOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const { name } = entry as { name?: unknown };
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function entryOf(name: string): unknown {
  return (IDENTITY_LOG_EVENTS as readonly unknown[]).find((entry) => nameOf(entry) === name);
}

describe('the identity contract declares the 002 Q42 lifecycle events (task 13.3)', () => {
  it.each([
    'catalog.audit.user_created',
    'catalog.audit.credential_created',
    'catalog.audit.credential_rotated',
    'catalog.security.credential_revoked',
  ])('declares %s exactly once', (name) => {
    const matches = (IDENTITY_LOG_EVENTS as readonly unknown[]).filter(
      (entry) => nameOf(entry) === name,
    );
    expect(matches).toHaveLength(1);
  });

  it('declares both forms of catalog.audit.user_created: the admin form and the bootstrap form with the operator id in place of the actor id', () => {
    const entry = entryOf('catalog.audit.user_created');
    expect(entry, 'the event is declared').toBeDefined();
    expect(typeof entry, 'an object, because a bare name cannot carry two forms').toBe('object');
    const serialized = JSON.stringify(entry);
    expect(serialized).toContain('tayzu.actor.id');
    expect(serialized).toContain('tayzu.identity.operator.id');
    expect(serialized).toContain('tayzu.identity.user.source');
    expect(serialized).toContain('"admin"');
    expect(serialized).toContain('"bootstrap"');
  });

  it('declares no catalog name in the authz-pinned contract.ts (it stays untouched)', async () => {
    const authContract = await import('./contract.js');
    const names = authContract.LOG_EVENTS.map((event) => event.name);
    expect(names.filter((name) => name.startsWith('catalog.'))).toEqual([]);
  });
});

/*
 * Task 15.1 (Resolved decision Q74): the rest of design.md's Observability
 * contract. Verify clause: "`identity-contract.test.ts` snapshot-asserts every
 * declared name and the attributes of every declared event (the invitation
 * events above, every form of `catalog.audit.user_status_changed` and both forms
 * of `catalog.audit.user_created` included)".
 *
 * ## Production symbols expected (`./identity-contract.js`)
 *
 * - `IDENTITY_SPANS`: `{ name, attributes }[]` (the required attributes).
 * - `IDENTITY_METRICS`: `{ name, attributes }[]`.
 * - `IDENTITY_LOG_EVENTS`: `{ name, severity, attributes? | forms?, conditional? }[]`;
 *   every entry an object (the four names of 13.3 gain their attributes and
 *   severity). `forms` keys the attribute list of each form; `conditional` lists
 *   attributes that a write may omit.
 * - `IDENTITY_ATTRIBUTE_VALUES`: `Record<attributeKey, string[]>`, the closed
 *   value set of each bounded attribute, plus the constant `invalid` of
 *   `tayzu.identity.invitation.id` and the value `sso_link_shed` of
 *   `tayzu.auth.revocation.reason`.
 *
 * The expectations live in `../__fixtures__/identity-contract-expected.ts`.
 * `catalog.security.authz_denied` is reused from 001/002 and is not declared here.
 */
interface Declared {
  readonly name: string;
  readonly severity?: string;
  readonly attributes?: readonly string[];
  readonly forms?: Readonly<Record<string, readonly string[]>>;
  readonly conditional?: readonly string[];
}

function asDeclared(list: unknown): Declared[] {
  return (list as readonly unknown[]).map((entry) =>
    typeof entry === 'string' ? { name: entry } : (entry as Declared),
  );
}

function byName(list: readonly Declared[], name: string): Declared | undefined {
  return list.find((entry) => entry.name === name);
}

function sorted(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

describe('the identity contract declares every remaining span, metric and log event (task 15.1)', () => {
  const spans = asDeclared((identityContract as Record<string, unknown>).IDENTITY_SPANS);
  const metrics = asDeclared((identityContract as Record<string, unknown>).IDENTITY_METRICS);
  const events = asDeclared(IDENTITY_LOG_EVENTS);

  it('declares exactly the spans of the design, each once', () => {
    expect(spans.map((s) => s.name).sort()).toEqual(EXPECTED_SPANS.map((s) => s.name).sort());
  });

  it.each(EXPECTED_SPANS.map((span) => [span.name, span] as const))(
    'span %s carries its required attributes',
    (name, expected) => {
      expect(sorted(byName(spans, name)?.attributes)).toEqual(sorted(expected.attributes));
    },
  );

  it('declares exactly the metrics of the design, each once', () => {
    expect(metrics.map((m) => m.name).sort()).toEqual(EXPECTED_METRICS.map((m) => m.name).sort());
  });

  it.each(EXPECTED_METRICS.map((metric) => [metric.name, metric] as const))(
    'metric %s carries exactly its attributes (no invited email, token or credential name)',
    (name, expected) => {
      expect(sorted(byName(metrics, name)?.attributes)).toEqual(sorted(expected.attributes));
    },
  );

  it('declares exactly the log events of the design, each once, and not the reused authz_denied', () => {
    const names = events.map((e) => e.name).sort();
    expect(names).toEqual(EXPECTED_LOG_EVENTS.map((e) => e.name).sort());
    expect(names).not.toContain('catalog.security.authz_denied');
  });

  it.each(EXPECTED_LOG_EVENTS.map((event) => [event.name, event] as const))(
    'log event %s carries its severity and attributes',
    (name, expected) => {
      const declared = byName(events, name);
      expect(declared, 'declared').toBeDefined();
      expect(declared?.severity).toBe(expected.severity);
      if (expected.forms === undefined) {
        expect(declared?.forms).toBeUndefined();
        expect(sorted(declared?.attributes)).toEqual(sorted(expected.attributes));
      } else {
        expect(Object.keys(declared?.forms ?? {}).sort()).toEqual(
          Object.keys(expected.forms).sort(),
        );
        for (const [form, attributes] of Object.entries(expected.forms)) {
          expect(sorted(declared?.forms?.[form]), `form ${form}`).toEqual(sorted(attributes));
        }
      }
      expect(sorted(declared?.conditional)).toEqual(sorted(expected.conditional));
    },
  );

  it('declares catalog.audit.user_status_changed with status.from conditional (absent for a created row) and a form without any principal for the ban hook', () => {
    const declared = byName(events, 'catalog.audit.user_status_changed');
    expect(declared?.conditional).toContain('tayzu.identity.user.status.from');
    const banHook = declared?.forms?.ban_hook ?? [];
    expect(banHook).not.toContain('tayzu.actor.id');
    expect(banHook).not.toContain('tayzu.identity.operator.id');
    expect(declared?.forms?.service_account).toContain('tayzu.identity.service_account.id');
    expect(declared?.forms?.service_account).not.toContain('tayzu.identity.user.id');
    expect(declared?.forms?.invitation).toContain('tayzu.identity.invitation.id');
  });

  it('declares the closed value set of every bounded attribute, including the new values', () => {
    const values = (identityContract as Record<string, unknown>).IDENTITY_ATTRIBUTE_VALUES as
      Readonly<Record<string, readonly string[]>> | undefined;
    expect(values, 'IDENTITY_ATTRIBUTE_VALUES is exported').toBeDefined();
    for (const [key, expected] of Object.entries(EXPECTED_ATTRIBUTE_VALUES)) {
      expect(sorted(values?.[key]), key).toEqual(sorted(expected));
    }
  });

  it('declares no attribute that names an invited email, token, secret or credential name', () => {
    const everyKey = [
      ...spans.flatMap((s) => s.attributes ?? []),
      ...metrics.flatMap((m) => m.attributes ?? []),
      ...events.flatMap((e) => [
        ...(e.attributes ?? []),
        ...Object.values(e.forms ?? {}).flat(),
        ...(e.conditional ?? []),
      ]),
    ];
    expect(everyKey.length).toBeGreaterThan(0);
    for (const key of everyKey) {
      // D15 (044): email.outcome is a closed value set (sent, suppressed, failed), never an address.
      expect(key).not.toMatch(
        /email(?!\.(template|outcome))|token|secret|\.name$|password|\bsub\b/,
      );
    }
  });
});

/*
 * Task 12.1 of openspec/changes/044-password-reset-and-account-recovery (design D15).
 *
 * ## Production symbols expected (`./identity-contract.js`)
 *
 * - `IDENTITY_SPANS` gains `identity.password_reset.request` (no attributes),
 *   `identity.password_reset.confirm` (no required attribute; `conditional:
 *   ['tayzu.identity.reset.mfa']`, a new optional `conditional` field on
 *   `IdentitySpanDeclaration`) and `identity.mfa.reset`
 *   (`tayzu.identity.mfa_reset.path`).
 * - `IDENTITY_METRICS` gains the four 044 counters.
 * - `IDENTITY_LOG_EVENTS` gains the six 044 events (`catalog.audit.mfa_reset`
 *   with forms `admin` and `operator`).
 * - `IDENTITY_ATTRIBUTE_VALUES` gains the 044 value sets and extends
 *   `tayzu.identity.email.template`, `tayzu.identity.conflict.reason` and
 *   `tayzu.auth.revocation.reason`.
 *
 * The expectations are in the fixture (`EXPECTED_*`), written from design D15.
 * The existing 043 cases above compare against the same fixture, so they also
 * cover every 044 name and attribute once those are declared.
 */
const EXPECTED_044_NAMES = {
  spans: [
    'identity.password_reset.request',
    'identity.password_reset.confirm',
    'identity.mfa.reset',
  ],
  metrics: [
    'tayzu.identity.password_reset_requests',
    'tayzu.identity.password_reset_confirms',
    'tayzu.identity.mfa_resets',
    'tayzu.identity.recovery_emails',
  ],
  events: [
    'catalog.audit.password_reset_requested',
    'catalog.audit.password_reset_completed',
    'catalog.audit.mfa_reset',
    'catalog.security.password_reset_denied',
    'catalog.security.recovery_email_suppressed',
    'catalog.security.self_mfa_reset_denied',
  ],
};

const VALUES_044 = [
  'tayzu.identity.reset.mfa',
  'tayzu.identity.reset.request_outcome',
  'tayzu.identity.reset.confirm_outcome',
  'tayzu.identity.reset.denial_reason',
  'tayzu.identity.recovery.suppression',
  'tayzu.identity.mfa_reset.path',
  'tayzu.identity.mfa_reset.reason',
  'tayzu.identity.conflict.reason',
  'tayzu.identity.email.template',
  'tayzu.identity.email.outcome',
  'tayzu.auth.revocation.reason',
];

describe('the identity contract declares the 044 telemetry of design D15 (task 12.1)', () => {
  const contract = identityContract as unknown as {
    IDENTITY_SPANS: readonly (Declared & { attributes: readonly string[] })[];
    IDENTITY_METRICS: readonly Declared[];
    IDENTITY_ATTRIBUTE_VALUES: Readonly<Record<string, readonly string[]>>;
  };
  const events = asDeclared(IDENTITY_LOG_EVENTS);

  it('every declared name and attribute equals the expected fixture', () => {
    for (const name of EXPECTED_044_NAMES.spans) {
      const expected = EXPECTED_SPANS.find((s) => s.name === name);
      expect(expected, `fixture has ${name}`).toBeDefined();
      const declared = byName(asDeclared(contract.IDENTITY_SPANS), name);
      expect(declared, `${name} declared`).toBeDefined();
      expect(sorted(declared?.attributes)).toEqual(sorted(expected?.attributes));
      expect(sorted(declared?.conditional)).toEqual(sorted(expected?.conditional));
    }
    for (const name of EXPECTED_044_NAMES.metrics) {
      const expected = EXPECTED_METRICS.find((m) => m.name === name);
      expect(expected, `fixture has ${name}`).toBeDefined();
      const declared = byName(asDeclared(contract.IDENTITY_METRICS), name);
      expect(declared, `${name} declared`).toBeDefined();
      expect(sorted(declared?.attributes)).toEqual(sorted(expected?.attributes));
    }
    for (const name of EXPECTED_044_NAMES.events) {
      const expected = EXPECTED_LOG_EVENTS.find((e) => e.name === name);
      expect(expected, `fixture has ${name}`).toBeDefined();
      const declared = byName(events, name);
      expect(declared, `${name} declared`).toBeDefined();
      expect(declared?.severity).toBe(expected?.severity);
      if (expected?.forms === undefined) {
        expect(declared?.forms).toBeUndefined();
        expect(sorted(declared?.attributes)).toEqual(sorted(expected?.attributes));
      } else {
        expect(Object.keys(declared?.forms ?? {}).sort()).toEqual(
          Object.keys(expected.forms).sort(),
        );
        for (const [form, attributes] of Object.entries(expected.forms)) {
          expect(sorted(declared?.forms?.[form]), `form ${form}`).toEqual(sorted(attributes));
        }
      }
      expect(sorted(declared?.conditional)).toEqual(sorted(expected?.conditional));
    }
  });

  it('declares the two denial and suppression events with the user id conditional', () => {
    expect(byName(events, 'catalog.security.password_reset_denied')?.conditional).toEqual([
      'tayzu.identity.user.id',
    ]);
    expect(byName(events, 'catalog.security.recovery_email_suppressed')?.conditional).toEqual([
      'tayzu.identity.user.id',
    ]);
    const operator = byName(events, 'catalog.audit.mfa_reset')?.forms?.operator ?? [];
    expect(operator).toContain('tayzu.identity.approver.id');
    expect(operator).toContain('tayzu.identity.operator.id');
  });

  it('the value sets equal design D15', () => {
    for (const key of VALUES_044) {
      expect(sorted(contract.IDENTITY_ATTRIBUTE_VALUES[key]), key).toEqual(
        sorted(EXPECTED_ATTRIBUTE_VALUES[key]),
      );
    }
    expect(
      sorted(contract.IDENTITY_ATTRIBUTE_VALUES['tayzu.identity.reset.denial_reason']),
    ).toEqual(
      sorted([
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
      ]),
    );
    expect(
      sorted(contract.IDENTITY_ATTRIBUTE_VALUES['tayzu.identity.recovery.suppression']),
    ).toEqual(
      sorted([
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
      ]),
    );
    expect(sorted(contract.IDENTITY_ATTRIBUTE_VALUES['tayzu.identity.conflict.reason'])).toEqual(
      sorted([
        'account_exists',
        'target_in_other_tenant',
        'sub_already_linked',
        'target_is_admin_or_owner',
        'no_enrolled_factor',
      ]),
    );
    expect(sorted(contract.IDENTITY_ATTRIBUTE_VALUES['tayzu.identity.email.template'])).toEqual(
      sorted([
        'invitation',
        'admin_accepted',
        'password_reset',
        'password_changed',
        'mfa_changed',
        'mfa_reset',
        'account_created',
      ]),
    );
  });

  it('the `tayzu.auth.revocation.reason` set equals `sso_link_shed`, `password_reset`, `mfa_reset`', () => {
    expect(sorted(contract.IDENTITY_ATTRIBUTE_VALUES['tayzu.auth.revocation.reason'])).toEqual([
      'mfa_reset',
      'password_reset',
      'sso_link_shed',
    ]);
  });

  it('`tayzu.identity.reset.mfa` is conditional on the confirm span', () => {
    const confirm = byName(asDeclared(contract.IDENTITY_SPANS), 'identity.password_reset.confirm');
    expect(confirm, 'declared').toBeDefined();
    expect(confirm?.attributes ?? []).not.toContain('tayzu.identity.reset.mfa');
    expect(confirm?.conditional).toEqual(['tayzu.identity.reset.mfa']);
    const request = byName(asDeclared(contract.IDENTITY_SPANS), 'identity.password_reset.request');
    expect(request?.attributes ?? []).toEqual([]);
    expect(request?.conditional ?? []).toEqual([]);
  });

  it('`tayzu.identity.notice.template` is unchanged', () => {
    expect(contract.IDENTITY_ATTRIBUTE_VALUES['tayzu.identity.notice.template']).toEqual([
      'admin_accepted',
    ]);
  });
});
