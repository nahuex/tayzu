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
  };
  readonly links: {
    /** An invitation of `email` as a member, as the invitation email carried it. */
    readonly invitation: { readonly email: string; readonly link: string };
    readonly passwordReset: { readonly email: string; readonly link: string };
    readonly passwordResetWithMfa: { readonly email: string; readonly link: string };
  };
  readonly catalog: SeedTenantCatalog & {
    /** The blueprint with at least 120 entities (task 10.7, "Sort by title and page forward"). */
    readonly paging: { readonly blueprint: string; readonly entityCount: number };
    /** `from` points at `to` through `relation` (task 10.7, "Related entities in both directions"). */
    readonly relation: {
      readonly from: SeedEntity;
      readonly to: SeedEntity;
      readonly relation: string;
      readonly relationTitle: string;
    };
    /** An entity with a written status (task 10.7, "Status shown next to spec"). */
    readonly status: {
      readonly entity: SeedEntity;
      readonly property: string;
      readonly propertyTitle: string;
      readonly value: string;
      readonly source: string;
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
