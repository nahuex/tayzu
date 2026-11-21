/**
 * The seed file of an e2e run (003 design D16, task 10.1): its layout, its path and its
 * reader. `seed.ts` writes it once per run, after the API is up; the shared fixture of
 * `test.ts` reads it. It holds every credential and link of the run, so it lives in the
 * run's state directory (`E2E_STATE_DIR`, outside the repository), with mode `0600`,
 * and nothing here ever prints it.
 *
 * This module has no dependency on the server code, so the Playwright process can load
 * it without starting anything.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_FILE_NAME = 'seed.json';
export const SEED_FILE_VERSION = 1;

/** A local account: the password is random per run. */
export interface SeedUser {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

/** A local account with an enrolled TOTP factor (`totpSecret` is the base32 secret). */
export interface SeedTotpUser extends SeedUser {
  readonly totpSecret: string;
}

/** A Visma Connect account: the OIDC stub signs in as `subject` with `email`. */
export interface SeedSsoUser {
  readonly email: string;
  readonly name: string;
  readonly subject: string;
}

export interface SeedEntity {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
}

export interface SeedBlueprint {
  readonly identifier: string;
  readonly title: string;
}

export interface SeedTenantCatalog {
  readonly blueprints: readonly SeedBlueprint[];
  readonly entities: readonly SeedEntity[];
}

export interface SeedTenantA {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly users: {
    /** Organization admin with TOTP. */
    readonly admin: SeedTotpUser;
    /** Organization admin without a factor: sent to enrolment (task 10.4). */
    readonly adminWithoutMfa: SeedUser;
    /** Member without MFA, own password set. */
    readonly member: SeedUser;
    /** Member still under the temporary password the admin's create returned. */
    readonly temporaryPassword: SeedUser;
    /** Member linked to the OIDC stub's subject. */
    readonly vismaConnect: SeedSsoUser;
    /** Member without MFA whose reset link is `links.passwordReset`. */
    readonly resetWithoutMfa: SeedUser;
    /** Member with TOTP whose reset link is `links.passwordResetWithMfa`. */
    readonly resetWithMfa: SeedTotpUser;
    /**
     * Member under a temporary password that `gates.spec.ts` changes to `newPassword`
     * (task 10.4, "A temporary password is changed"). Single-use: no other spec may sign
     * it in. `temporaryPassword` above stays under its temporary password for the
     * specs that only visit the gate.
     */
    readonly temporaryPasswordChange: SeedUser & { readonly newPassword: string };
    /**
     * Organization admin without a factor, own password set, that `gates.spec.ts`
     * enrols (task 10.4, "MFA enrolment completes only with a valid code"). Single-use:
     * after that spec it has a factor. `adminWithoutMfa` above is never enrolled.
     */
    readonly mfaEnrolee: SeedUser;
    /** Member with TOTP who deletes `catalog.stepUpDeletable.totp` (task 10.5). */
    readonly stepUpTotp: SeedTotpUser;
    /** Member without MFA who deletes `catalog.stepUpDeletable.password` (task 10.5). */
    readonly stepUpPassword: SeedUser;
  };
  readonly links: {
    /**
     * An invitation of `email` (no account yet) as a member, as the invitation email
     * carried it, and the policy-compliant password the invitee chooses (task 10.6).
     */
    readonly invitation: {
      readonly email: string;
      readonly link: string;
      readonly password: string;
    };
    /** The reset link of `resetWithoutMfa`, and the new password `links.spec.ts` sets. */
    readonly passwordReset: {
      readonly email: string;
      readonly link: string;
      readonly newPassword: string;
    };
    /** The reset link of `resetWithMfa`, and the new password `links.spec.ts` sets. */
    readonly passwordResetWithMfa: {
      readonly email: string;
      readonly link: string;
      readonly newPassword: string;
    };
  };
  readonly catalog: SeedTenantCatalog & {
    /** The blueprint with at least 120 entities (task 10.7, "Sort by title and page forward"). */
    readonly paging: { readonly blueprint: string; readonly entityCount: number };
    /**
     * `from` points at `to` through `relation` (task 10.7, "Related entities in both
     * directions": `payments-api` depends on `svc-ledger`). `to` is the target of no
     * other relation of `from`, and `from` points at nothing else in `to`'s blueprint.
     */
    readonly relation: {
      readonly from: SeedEntity;
      readonly to: SeedEntity;
      readonly relation: string;
      readonly relationTitle: string;
    };
    /**
     * `entity`'s identifier starts with `query`, and no other identifier of tenant A
     * does, so the server ranks it the first entity result (task 10.7, "Search by
     * identifier prefix from the keyboard").
     */
    readonly prefixSearch: { readonly entity: SeedEntity; readonly query: string };
    /**
     * An entity the Visma Connect user created (through a local session of the same
     * user), so that member may delete it (`catalog_entity.yaml`: a member deletes what
     * they created). Task 10.3 deletes it, so it is not in `entities` and no other spec
     * may rely on it.
     */
    readonly vismaConnectDeletable: SeedEntity;
    /**
     * Entities `users.stepUpTotp` and `users.stepUpPassword` created through local
     * sessions of their own, so each member may delete theirs. Task 10.5 deletes both,
     * so they are not in `entities` and no other spec may rely on them.
     */
    readonly stepUpDeletable: { readonly totp: SeedEntity; readonly password: SeedEntity };
    /** An entity with a written status (task 10.7, "Status shown next to spec"). */
    readonly status: {
      readonly entity: SeedEntity;
      readonly property: string;
      readonly propertyTitle: string;
      readonly value: string;
      readonly source: string;
      /** The generation the status was written for: the entity's generation at the time. */
      readonly observedGeneration: number;
      /** A spec property of the same entity, shown next to the status (Q86). */
      readonly specProperty: { readonly title: string; readonly value: string };
    };
  };
}

export interface SeedTenantB {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly users: { readonly admin: SeedTotpUser };
  readonly catalog: SeedTenantCatalog & {
    /** A blueprint only tenant B has (task 10.10, "Another tenant's blueprint is not found"). */
    readonly ownBlueprint: SeedBlueprint;
    /** An entity of B in a blueprint identifier tenant A also has (task 10.10). */
    readonly sharedIdentifierEntity: SeedEntity;
    /**
     * An entity of B whose identifier and title start with `query`, while nothing of
     * tenant A matches `query` by prefix or by title similarity (task 10.10, "Search
     * never shows another tenant's entity").
     */
    readonly searchOnly: { readonly entity: SeedEntity; readonly query: string };
  };
}

export interface E2eSeed {
  readonly version: typeof SEED_FILE_VERSION;
  /** The app's https origin (the TLS proxy), e.g. `https://localhost:8443`. */
  readonly appOrigin: string;
  /** The OIDC stub's https origin, the only other origin a flow may reach. */
  readonly oidcOrigin: string;
  readonly tenants: { readonly a: SeedTenantA; readonly b: SeedTenantB };
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * The absolute path of the seed file, from `E2E_STATE_DIR`. Fails closed, naming the
 * variable only, when it is unset, relative or inside the repository.
 */
export function seedFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const dir = env['E2E_STATE_DIR'];
  if (dir === undefined || dir.trim() === '') {
    throw new Error('E2E_STATE_DIR is not set: run the suite through scripts/ci/e2e.sh.');
  }
  if (!isAbsolute(dir)) throw new Error('E2E_STATE_DIR must be an absolute path.');
  const fromRepo = relative(REPO_ROOT, dir);
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !isAbsolute(fromRepo))) {
    throw new Error('E2E_STATE_DIR must be outside the repository.');
  }
  return join(dir, SEED_FILE_NAME);
}

/** Reads the seed file; refuses one readable by anyone but its owner, or of another version. */
export function readSeed(path: string = seedFilePath()): E2eSeed {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error('The e2e seed file must have mode 0600.');
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (parsed.version !== SEED_FILE_VERSION) {
    throw new Error('The e2e seed file has an unexpected version: run e2e.sh up again.');
  }
  return parsed as E2eSeed;
}
