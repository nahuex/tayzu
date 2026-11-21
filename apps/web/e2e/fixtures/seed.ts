/**
 * The e2e seed (003 design D1 and D16, task 10.1). `scripts/ci/e2e.sh up` runs it once,
 * after `apps/api` is healthy and the TLS proxy is started:
 *
 *   TAYZU_OPERATOR_ID=ci:e2e-seed pnpm exec tsx apps/web/e2e/fixtures/seed.ts
 *
 * with the API's own environment (`loadConfig` reads it, `NODE_ENV` is not `test`), plus
 * `E2E_STATE_DIR`, `E2E_OIDC_SUBJECT` and `E2E_OIDC_EMAIL`.
 *
 * It works through the real services, never through SQL:
 *
 * - each tenant and its first admin come from the bootstrap CLI
 *   (`apps/api/scripts/bootstrap-admin.ts`), as an operator runs it, its output read
 *   and never echoed (as `scripts/ci/zap-seed.ts` does);
 * - everything else goes through an in-process `createApp` built from the same
 *   configuration as the running API, but with `043`'s recording email sender, so the
 *   invitation and reset links are captured instead of sent. Requests are injected
 *   (`app.inject`), never sent over a socket. The links are valid for the running API:
 *   both processes share the database and the secrets.
 *
 * Every password is random per run. The credentials, the TOTP secrets and the links go
 * to `$E2E_STATE_DIR/seed.json` (mode 0600, layout in `./seed-file.ts`) and are never
 * printed; an error names a step, a status and a stable code only.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig, type Config } from '../../../api/src/config.js';
import { createApp, type App } from '../../../api/src/server.js';
import {
  createRecordingEmailSender,
  generateTemporaryPassword,
  type EmailTemplate,
} from '../../../../packages/auth/src/index.js';
import { createPool } from '../../../../packages/db/src/index.js';
import { totpCode } from '../../../../scripts/ci/zap-seed.js';
import {
  SEED_FILE_VERSION,
  seedFilePath,
  type E2eSeed,
  type SeedBlueprint,
  type SeedEntity,
  type SeedTenantA,
  type SeedTenantB,
  type SeedTotpUser,
  type SeedUser,
} from './seed-file.js';

type Env = Readonly<Record<string, string | undefined>>;
type RecordingEmailSender = ReturnType<typeof createRecordingEmailSender>;

const TOTP_STEP_SECONDS = 30;
const EMAIL_WAIT_MS = 20_000;
const STATUS_SOURCE = 'e2e-seed';
const PAGING_ENTITY_COUNT = 120;

/** Fails closed naming the variable only, never its value. */
function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set: the e2e seed needs it.`);
  }
  return value;
}

/**
 * A path segment, raw. The server's Q74 hook answers 404 to any target that holds a `%`,
 * so a segment is never percent-encoded; a value that would need it is refused instead.
 * `@` is a valid path character (RFC 3986 `pchar`), so an email address passes as is.
 */
function pathSegment(value: string): string {
  if (!/^[A-Za-z0-9@._~:=+-]+$/.test(value)) {
    throw new Error('A seeded path segment holds a character that needs encoding.');
  }
  return value;
}

/** A short random tag, so every run's addresses and slugs are new. */
const RUN = randomBytes(4).toString('hex');

function address(role: string): string {
  return `e2e-${role}-${RUN}@example.test`;
}

/** A password that satisfies the policy, random per run (the generator of `043`). */
function randomPassword(): string {
  return generateTemporaryPassword();
}

// ---------------------------------------------------------------------------
// The bootstrap CLI, as an operator runs it
// ---------------------------------------------------------------------------

/**
 * Runs the bootstrap CLI through `@tayzu/api` and returns the one-time password it
 * prints. Its standard output is captured and never echoed.
 */
function bootstrapTenant(params: {
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly adminName: string;
  readonly adminEmail: string;
}): string {
  const script = fileURLToPath(new URL('../../../api/scripts/bootstrap-admin.ts', import.meta.url));
  const output = execFileSync('pnpm', ['--filter', '@tayzu/api', 'exec', 'tsx', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      BOOTSTRAP_ORGANIZATION_NAME: params.organizationName,
      BOOTSTRAP_ORGANIZATION_SLUG: params.organizationSlug,
      BOOTSTRAP_ADMIN_NAME: params.adminName,
      BOOTSTRAP_ADMIN_EMAIL: params.adminEmail,
    },
  });
  const password = /temporary password and change it immediately: (\S+)/.exec(output)?.[1];
  if (password === undefined) {
    throw new Error('The bootstrap CLI created no organization: use a fresh database.');
  }
  return password;
}

// ---------------------------------------------------------------------------
// Injected requests against the in-process app
// ---------------------------------------------------------------------------

/** The cookies of one browser-like session; a cleared cookie is dropped. */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  absorb(cookies: readonly { name: string; value: string; maxAge?: number }[]): void {
    for (const cookie of cookies) {
      if (cookie.value === '' || cookie.maxAge === 0) this.#cookies.delete(cookie.name);
      else this.#cookies.set(cookie.name, cookie.value);
    }
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A stable upper-case code of an error body, never a message or an echoed value. */
function codeOf(body: Record<string, unknown>): string {
  const code = body['code'];
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? ` (${code})` : '';
}

class SeedClient {
  constructor(
    private readonly app: App,
    private readonly origin: string,
  ) {}

  /**
   * One same-origin JSON request, as the browser on the https front end sends it (the
   * `Origin` header and oRPC's CSRF header). Fails naming the step, the status and
   * the stable code only.
   */
  async request(
    step: string,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    options: { readonly body?: unknown; readonly jar?: CookieJar; readonly accept?: number[] } = {},
  ): Promise<Answer> {
    const response = await this.app.app.inject({
      method,
      url,
      headers: {
        origin: this.origin,
        'x-csrf-token': 'orpc',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.jar === undefined ? {} : { cookie: options.jar.header() }),
      },
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });
    options.jar?.absorb(response.cookies);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = response.json();
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    const accepted = options.accept ?? [200, 201];
    if (!accepted.includes(response.statusCode)) {
      throw new Error(`${step} failed with status ${String(response.statusCode)}${codeOf(body)}.`);
    }
    return { status: response.statusCode, body };
  }
}

async function nextTotpStep(): Promise<number> {
  const now = Date.now() / 1000;
  const next = (Math.floor(now / TOTP_STEP_SECONDS) + 1) * TOTP_STEP_SECONDS;
  await new Promise((resolve) => setTimeout(resolve, (next - now) * 1000 + 250));
  return Date.now() / 1000;
}

/** Signs in with a password; `twoFactor` is true when a TOTP challenge follows. */
async function signIn(
  client: SeedClient,
  email: string,
  password: string,
): Promise<{ readonly jar: CookieJar; readonly twoFactor: boolean }> {
  const jar = new CookieJar();
  const answer = await client.request('sign-in', 'POST', '/api/auth/sign-in/email', {
    body: { email, password },
    jar,
  });
  return { jar, twoFactor: answer.body['twoFactorRedirect'] === true };
}

/** Replaces a temporary password with a random one, as the change-password page does. */
async function changePassword(
  client: SeedClient,
  jar: CookieJar,
  currentPassword: string,
): Promise<string> {
  const newPassword = randomPassword();
  await client.request('change-password', 'POST', '/api/auth/change-password', {
    body: { currentPassword, newPassword },
    jar,
  });
  return newPassword;
}

/** Enrols a TOTP factor for the signed-in user and returns its base32 secret. */
async function enrolTotp(client: SeedClient, jar: CookieJar, password: string): Promise<string> {
  const enabled = await client.request('two-factor enable', 'POST', '/api/auth/two-factor/enable', {
    body: { password },
    jar,
  });
  const uri = enabled.body['totpURI'];
  const secret = typeof uri === 'string' ? new URL(uri).searchParams.get('secret') : null;
  if (secret === null) throw new Error('two-factor enable returned no TOTP secret.');
  await client.request('two-factor enrol', 'POST', '/api/auth/two-factor/verify-totp', {
    body: { code: totpCode(secret, Date.now() / 1000) },
    jar,
  });
  return secret;
}

/** A session with a fresh MFA verification, through a real TOTP challenge. */
async function signInWithTotp(
  client: SeedClient,
  email: string,
  password: string,
  secret: string,
): Promise<CookieJar> {
  const { jar, twoFactor } = await signIn(client, email, password);
  if (!twoFactor) throw new Error('sign-in of an enrolled user asked for no second factor.');
  // A fresh time step, so the sign-in code is never the enrolment code.
  const now = await nextTotpStep();
  await client.request('two-factor sign-in', 'POST', '/api/auth/two-factor/verify-totp', {
    body: { code: totpCode(secret, now) },
    jar,
  });
  return jar;
}

/**
 * A bootstrapped admin: the temporary password changed, TOTP enrolled, then signed in
 * again through the TOTP challenge, so the session can run high-risk operations.
 */
async function enrolledAdmin(
  client: SeedClient,
  admin: { readonly email: string; readonly name: string; readonly temporaryPassword: string },
): Promise<{ readonly user: SeedTotpUser; readonly jar: CookieJar }> {
  const first = await signIn(client, admin.email, admin.temporaryPassword);
  const password = await changePassword(client, first.jar, admin.temporaryPassword);
  const totpSecret = await enrolTotp(client, first.jar, password);
  const jar = await signInWithTotp(client, admin.email, password, totpSecret);
  return { user: { email: admin.email, name: admin.name, password, totpSecret }, jar };
}

/** `identity.users.create`: a new member or admin under a temporary password. */
async function createUser(
  client: SeedClient,
  adminJar: CookieJar,
  user: { readonly email: string; readonly name: string; readonly role: 'admin' | 'member' },
): Promise<SeedUser> {
  const answer = await client.request('identity.users.create', 'POST', '/v1/users', {
    body: user,
    jar: adminJar,
  });
  const temporaryPassword = answer.body['temporaryPassword'];
  if (typeof temporaryPassword !== 'string') {
    throw new Error('identity.users.create returned no temporary password.');
  }
  return { email: user.email, name: user.name, password: temporaryPassword };
}

/** Signs a user in once and sets their own password, so no temporary-password gate remains. */
async function settlePassword(client: SeedClient, user: SeedUser): Promise<SeedUser> {
  const { jar } = await signIn(client, user.email, user.password);
  return { ...user, password: await changePassword(client, jar, user.password) };
}

/** The link of the first email of `kind` sent to `to`; the send may be detached. */
async function capturedLink(
  sender: RecordingEmailSender,
  to: string,
  kind: 'InvitationEmail' | 'PasswordResetEmail',
): Promise<string> {
  const deadline = Date.now() + EMAIL_WAIT_MS;
  for (;;) {
    const message = sender.sent.find(
      (candidate) => candidate.to === to && candidate.template.kind === kind,
    );
    const template = message?.template as Extract<EmailTemplate, { link: string }> | undefined;
    if (template !== undefined) return template.link;
    if (Date.now() > deadline) throw new Error(`No ${kind} was recorded in time.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

async function createBlueprint(
  client: SeedClient,
  jar: CookieJar,
  body: Record<string, unknown> & {
    readonly identifier: string;
    readonly title: { readonly en: string; readonly es?: string };
  },
): Promise<SeedBlueprint> {
  await client.request('blueprints.create', 'POST', '/v1/blueprints', { body, jar });
  return { identifier: body.identifier, title: body.title.en };
}

async function createEntity(
  client: SeedClient,
  jar: CookieJar,
  entity: SeedEntity & { readonly spec?: Record<string, unknown> },
): Promise<{ readonly entity: SeedEntity; readonly generation: number }> {
  const answer = await client.request(
    'entities.create',
    'POST',
    `/v1/blueprints/${pathSegment(entity.blueprint)}/entities`,
    {
      body: {
        identifier: entity.identifier,
        title: entity.title,
        ...(entity.spec === undefined ? {} : { spec: entity.spec }),
      },
      jar,
    },
  );
  const generation = answer.body['generation'];
  if (typeof generation !== 'number') throw new Error('entities.create returned no generation.');
  return {
    entity: { blueprint: entity.blueprint, identifier: entity.identifier, title: entity.title },
    generation,
  };
}

/**
 * An entity created by `user` through a local session of their own, so `created_by_id`
 * is that user's id: the attribute that lets a member delete it.
 */
async function createdBy(
  client: SeedClient,
  user: SeedUser,
  entity: SeedEntity & { readonly spec?: Record<string, unknown> },
): Promise<SeedEntity> {
  const { jar, twoFactor } = await signIn(client, user.email, user.password);
  if (twoFactor) throw new Error('sign-in of a user without a factor asked for one.');
  return (await createEntity(client, jar, entity)).entity;
}

async function seedCatalogA(
  client: SeedClient,
  jar: CookieJar,
): Promise<
  Omit<SeedTenantA['catalog'], 'vismaConnectDeletable' | 'stepUpDeletable' | 'dialogEntities'>
> {
  const team = await createBlueprint(client, jar, {
    identifier: 'team',
    title: { en: 'Team', es: 'Equipo' },
    schema: { properties: { channel: { type: 'string', title: { en: 'Channel', es: 'Canal' } } } },
  });
  const service = await createBlueprint(client, jar, {
    identifier: 'service',
    title: { en: 'Service', es: 'Servicio' },
    schema: {
      properties: {
        language: {
          type: 'string',
          title: { en: 'Language', es: 'Lenguaje' },
          enum: ['typescript', 'go', 'python'],
        },
      },
    },
    statusSchema: {
      properties: {
        health: {
          type: 'string',
          title: { en: 'Health', es: 'Salud' },
          enum: ['healthy', 'degraded', 'down'],
        },
      },
    },
    relations: {
      owner: { title: { en: 'Owner', es: 'Responsable' }, target: 'team', many: false },
      dependsOn: { title: { en: 'Depends on', es: 'Depende de' }, target: 'service', many: true },
    },
  });
  const component = await createBlueprint(client, jar, {
    identifier: 'component',
    title: { en: 'Component', es: 'Componente' },
    schema: { properties: { kind: { type: 'string', title: { en: 'Kind', es: 'Tipo' } } } },
  });

  const entities: SeedEntity[] = [];
  const add = async (
    entity: SeedEntity & { readonly spec?: Record<string, unknown> },
  ): Promise<{ readonly entity: SeedEntity; readonly generation: number }> => {
    const created = await createEntity(client, jar, entity);
    entities.push(created.entity);
    return created;
  };

  await add({
    blueprint: 'team',
    identifier: 'team-payments',
    title: 'Payments team',
    spec: { properties: { channel: 'payments' } },
  });
  await add({
    blueprint: 'team',
    identifier: 'team-platform',
    title: 'Platform team',
    spec: { properties: { channel: 'platform' } },
  });
  const ledger = await add({
    blueprint: 'service',
    identifier: 'svc-ledger',
    title: 'Ledger',
    spec: { properties: { language: 'go' }, relations: { owner: 'team-payments' } },
  });
  const checkout = await add({
    blueprint: 'service',
    identifier: 'svc-checkout',
    title: 'Checkout',
    spec: {
      properties: { language: 'typescript' },
      relations: { owner: 'team-payments', dependsOn: ['svc-ledger'] },
    },
  });
  // "Related entities in both directions" and "Search by identifier prefix": the only
  // identifier of tenant A that starts with `paym`.
  const paymentsApi = await add({
    blueprint: 'service',
    identifier: 'payments-api',
    title: 'Payments API',
    spec: {
      properties: { language: 'go' },
      relations: { owner: 'team-platform', dependsOn: ['svc-ledger'] },
    },
  });
  await add({
    blueprint: 'service',
    identifier: 'svc-gateway',
    title: 'Gateway',
    spec: {
      properties: { language: 'python' },
      relations: { owner: 'team-platform', dependsOn: ['svc-checkout'] },
    },
  });

  // Titles in another order than the identifiers (37 is coprime with 120), so a sort by
  // title is visibly not a sort by identifier.
  for (let index = 0; index < PAGING_ENTITY_COUNT; index += 1) {
    const rank = String((index * 37) % PAGING_ENTITY_COUNT).padStart(3, '0');
    await add({
      blueprint: 'component',
      identifier: `cmp-${String(index).padStart(3, '0')}`,
      title: `Component ${rank}`,
      spec: { properties: { kind: index % 2 === 0 ? 'library' : 'job' } },
    });
  }

  await client.request(
    'entities.writeStatus',
    'PUT',
    '/v1/blueprints/service/entities/svc-checkout/status',
    {
      body: {
        properties: { health: 'degraded' },
        observedGeneration: checkout.generation,
        source: STATUS_SOURCE,
      },
      jar,
    },
  );

  return {
    blueprints: [team, service, component],
    entities,
    paging: { blueprint: component.identifier, entityCount: PAGING_ENTITY_COUNT },
    relation: {
      from: paymentsApi.entity,
      to: ledger.entity,
      relation: 'dependsOn',
      relationTitle: 'Depends on',
    },
    prefixSearch: { entity: paymentsApi.entity, query: 'paym' },
    status: {
      entity: checkout.entity,
      property: 'health',
      propertyTitle: 'Health',
      value: 'degraded',
      source: STATUS_SOURCE,
      observedGeneration: checkout.generation,
      specProperty: { title: 'Language', value: 'typescript' },
    },
  };
}

async function seedCatalogB(client: SeedClient, jar: CookieJar): Promise<SeedTenantB['catalog']> {
  const service = await createBlueprint(client, jar, {
    identifier: 'service',
    title: { en: 'Service', es: 'Servicio' },
    schema: { properties: { language: { type: 'string', title: { en: 'Language' } } } },
  });
  const vault = await createBlueprint(client, jar, {
    identifier: 'vault',
    title: { en: 'Vault', es: 'Bóveda' },
    schema: { properties: { region: { type: 'string', title: { en: 'Region' } } } },
  });
  const shared = await createEntity(client, jar, {
    blueprint: 'service',
    identifier: 'svc-tenant-b-only',
    title: 'Tenant B only service',
    spec: { properties: { language: 'go' } },
  });
  // Tenant A has a `service` blueprint too, and nothing of A matches `secret`.
  const secret = await createEntity(client, jar, {
    blueprint: 'service',
    identifier: 'secret-svc',
    title: 'Secret service',
    spec: { properties: { language: 'go' } },
  });
  const own = await createEntity(client, jar, {
    blueprint: 'vault',
    identifier: 'vault-main',
    title: 'Tenant B vault',
    spec: { properties: { region: 'north' } },
  });
  return {
    blueprints: [service, vault],
    entities: [shared.entity, secret.entity, own.entity],
    ownBlueprint: vault,
    sharedIdentifierEntity: shared.entity,
    searchOnly: { entity: secret.entity, query: 'secret' },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** The in-process app: the running API's configuration, with the recording sender. */
async function buildApp(
  config: Config,
  sender: RecordingEmailSender,
  appOrigin: string,
): Promise<{ readonly app: App; close(): Promise<void> }> {
  const hmacSecret = config.identityTokenHmacSecret;
  if (hmacSecret === undefined) throw new Error('IDENTITY_TOKEN_HMAC_SECRET is not set.');
  const appPool = createPool(config.appDatabaseUrl);
  const authPool = createPool(config.authDatabaseUrl);
  try {
    const app = await createApp({
      appPool,
      authPool,
      authSecret: config.betterAuthSecret,
      cerbosAddress: config.cerbosAddress,
      allowedOrigins: config.allowedOrigins,
      baseUrl: appOrigin,
      mountIdentityRoutes: true,
      identityTokenHmacSecret: hmacSecret,
      email: {
        sender,
        invitationLinkBaseUrl: required(process.env, 'INVITATION_LINK_BASE_URL'),
        passwordResetLinkBaseUrl: required(process.env, 'PASSWORD_RESET_LINK_BASE_URL'),
        disabledTenantIds: [],
        killSwitch: false,
        ...(config.emailRecipientDomainAllowlist.length === 0
          ? {}
          : { recipientDomainAllowlist: config.emailRecipientDomainAllowlist }),
        recipientKeySecret: hmacSecret,
        tenantCap: config.invitationTenantCap,
        recipientCap: config.invitationRecipientCap,
        passwordResetMinResponseMs: config.passwordResetMinResponseMs,
      },
    });
    return {
      app,
      async close() {
        await app.close();
        await appPool.end();
        await authPool.end();
      },
    };
  } catch (error) {
    await appPool.end();
    await authPool.end();
    throw error;
  }
}

export async function seed(env: Env = process.env): Promise<E2eSeed> {
  if (env['NODE_ENV'] === 'test') {
    throw new Error('The e2e seed runs against the production configuration, never NODE_ENV=test.');
  }
  const target = seedFilePath(env);
  const config = loadConfig(env);
  const appOrigin = config.betterAuthUrl;
  if (appOrigin === undefined || new URL(appOrigin).protocol !== 'https:') {
    throw new Error('BETTER_AUTH_URL must be the https origin of the TLS proxy.');
  }
  if (config.allowedOrigins[0] !== appOrigin) {
    throw new Error('ALLOWED_ORIGINS must start with BETTER_AUTH_URL.');
  }
  if (config.sso === undefined) {
    throw new Error('VISMA_CONNECT_DISCOVERY_URL is not set: the OIDC stub stands in for it.');
  }
  const oidcOrigin = new URL(config.sso.discoveryUrl).origin;
  const ssoSubject = required(env, 'E2E_OIDC_SUBJECT');
  const ssoEmail = required(env, 'E2E_OIDC_EMAIL');

  const adminA = {
    email: address('admin-a'),
    name: 'E2E Admin A',
    organizationName: 'E2E Tenant A',
    organizationSlug: `e2e-a-${RUN}`,
  };
  const adminB = {
    email: address('admin-b'),
    name: 'E2E Admin B',
    organizationName: 'E2E Tenant B',
    organizationSlug: `e2e-b-${RUN}`,
  };
  const temporaryA = bootstrapTenant({
    ...adminA,
    adminName: adminA.name,
    adminEmail: adminA.email,
  });
  const temporaryB = bootstrapTenant({
    ...adminB,
    adminName: adminB.name,
    adminEmail: adminB.email,
  });

  const sender = createRecordingEmailSender();
  const built = await buildApp(config, sender, appOrigin);
  try {
    const client = new SeedClient(built.app, appOrigin);

    // Tenant A. The high-risk identity operations run first, inside the five minutes of
    // the admin's fresh MFA verification.
    const a = await enrolledAdmin(client, { ...adminA, temporaryPassword: temporaryA });
    const created = {
      adminWithoutMfa: await createUser(client, a.jar, {
        email: address('admin-nomfa'),
        name: 'E2E Admin Without MFA',
        role: 'admin',
      }),
      member: await createUser(client, a.jar, {
        email: address('member'),
        name: 'E2E Member',
        role: 'member',
      }),
      temporaryPassword: await createUser(client, a.jar, {
        email: address('temporary'),
        name: 'E2E Temporary Password',
        role: 'member',
      }),
      vismaConnect: await createUser(client, a.jar, {
        email: ssoEmail,
        name: 'E2E Visma Connect',
        role: 'member',
      }),
      resetWithoutMfa: await createUser(client, a.jar, {
        email: address('reset'),
        name: 'E2E Reset',
        role: 'member',
      }),
      resetWithMfa: await createUser(client, a.jar, {
        email: address('reset-mfa'),
        name: 'E2E Reset With MFA',
        role: 'member',
      }),
      temporaryPasswordChange: await createUser(client, a.jar, {
        email: address('temporary-change'),
        name: 'E2E Temporary Password Change',
        role: 'member',
      }),
      mfaEnrolee: await createUser(client, a.jar, {
        email: address('mfa-enrolee'),
        name: 'E2E MFA Enrolee',
        role: 'admin',
      }),
      stepUpTotp: await createUser(client, a.jar, {
        email: address('step-up-totp'),
        name: 'E2E Step-up TOTP',
        role: 'member',
      }),
      stepUpPassword: await createUser(client, a.jar, {
        email: address('step-up-password'),
        name: 'E2E Step-up Password',
        role: 'member',
      }),
      dialogOwner: await createUser(client, a.jar, {
        email: address('dialog-owner'),
        name: 'E2E Dialog Owner',
        role: 'member',
      }),
    };
    await client.request(
      'identity.users.linkSsoAccount',
      'POST',
      `/v1/users/${pathSegment(ssoEmail)}/sso-account`,
      { body: { subject: ssoSubject }, jar: a.jar },
    );
    const inviteeEmail = address('invitee');
    await client.request('identity.users.invite', 'POST', '/v1/users/invitations', {
      body: { email: inviteeEmail, role: 'member' },
      jar: a.jar,
    });
    const invitationLink = await capturedLink(sender, inviteeEmail, 'InvitationEmail');

    const adminWithoutMfa = await settlePassword(client, created.adminWithoutMfa);
    const member = await settlePassword(client, created.member);
    // Signed in once with a password of its own, so the Visma Connect session meets no
    // temporary-password gate; the stub's subject is what it signs in with. The password
    // is kept in memory only, for the entity it creates below, and never written.
    const vismaConnectLocal = await settlePassword(client, created.vismaConnect);
    const mfaEnrolee = await settlePassword(client, created.mfaEnrolee);
    const stepUpPassword = await settlePassword(client, created.stepUpPassword);
    const dialogOwner = await settlePassword(client, created.dialogOwner);
    // Enrolled after it creates its entity (below), which needs a sign-in without a factor.
    const stepUpTotpSettled = await settlePassword(client, created.stepUpTotp);
    const resetWithoutMfa = await settlePassword(client, created.resetWithoutMfa);
    const resetWithMfaSettled = await settlePassword(client, created.resetWithMfa);
    const resetMfaSession = await signIn(
      client,
      resetWithMfaSettled.email,
      resetWithMfaSettled.password,
    );
    const resetWithMfa: SeedTotpUser = {
      ...resetWithMfaSettled,
      totpSecret: await enrolTotp(client, resetMfaSession.jar, resetWithMfaSettled.password),
    };

    for (const user of [resetWithoutMfa, resetWithMfa]) {
      await client.request('password reset request', 'POST', '/v1/auth/password-reset/request', {
        body: { email: user.email },
      });
    }
    const passwordResetLink = await capturedLink(
      sender,
      resetWithoutMfa.email,
      'PasswordResetEmail',
    );
    const passwordResetWithMfaLink = await capturedLink(
      sender,
      resetWithMfa.email,
      'PasswordResetEmail',
    );

    const catalogA = {
      ...(await seedCatalogA(client, a.jar)),
      vismaConnectDeletable: await createdBy(client, vismaConnectLocal, {
        blueprint: 'team',
        identifier: 'team-sso-deletable',
        title: 'Visma Connect deletable team',
        spec: { properties: { channel: 'sso-deletable' } },
      }),
      stepUpDeletable: {
        totp: await createdBy(client, stepUpTotpSettled, {
          blueprint: 'team',
          identifier: 'team-step-up-totp',
          title: 'Step-up TOTP deletable team',
          spec: { properties: { channel: 'step-up-totp' } },
        }),
        password: await createdBy(client, stepUpPassword, {
          blueprint: 'team',
          identifier: 'team-step-up-password',
          title: 'Step-up password deletable team',
          spec: { properties: { channel: 'step-up-password' } },
        }),
      },
      // Tasks 10.8 and 10.9 open the step-up prompt of their deletes and cancel it.
      dialogEntities: {
        local: await createdBy(client, dialogOwner, {
          blueprint: 'team',
          identifier: 'team-dialog-local',
          title: 'Dialog team',
          spec: { properties: { channel: 'dialog-local' } },
        }),
        vismaConnect: await createdBy(client, vismaConnectLocal, {
          blueprint: 'team',
          identifier: 'team-dialog-sso',
          title: 'Visma Connect dialog team',
          spec: { properties: { channel: 'dialog-sso' } },
        }),
      },
    };
    const stepUpTotpSession = await signIn(
      client,
      stepUpTotpSettled.email,
      stepUpTotpSettled.password,
    );
    const stepUpTotp: SeedTotpUser = {
      ...stepUpTotpSettled,
      totpSecret: await enrolTotp(client, stepUpTotpSession.jar, stepUpTotpSettled.password),
    };
    const me = await client.request('GET /v1/me', 'GET', '/v1/me', { jar: a.jar });
    const tenantAId = (me.body['organization'] as { id?: unknown } | undefined)?.id;

    // Tenant B.
    const b = await enrolledAdmin(client, { ...adminB, temporaryPassword: temporaryB });
    const catalogB = await seedCatalogB(client, b.jar);
    const meB = await client.request('GET /v1/me', 'GET', '/v1/me', { jar: b.jar });
    const tenantBId = (meB.body['organization'] as { id?: unknown } | undefined)?.id;
    if (typeof tenantAId !== 'string' || typeof tenantBId !== 'string') {
      throw new Error('GET /v1/me returned no organization id.');
    }

    const result: E2eSeed = {
      version: SEED_FILE_VERSION,
      appOrigin,
      oidcOrigin,
      tenants: {
        a: {
          id: tenantAId,
          name: adminA.organizationName,
          slug: adminA.organizationSlug,
          users: {
            admin: a.user,
            adminWithoutMfa,
            member,
            temporaryPassword: created.temporaryPassword,
            vismaConnect: { email: ssoEmail, name: created.vismaConnect.name, subject: ssoSubject },
            resetWithoutMfa,
            resetWithMfa,
            temporaryPasswordChange: {
              ...created.temporaryPasswordChange,
              newPassword: randomPassword(),
            },
            mfaEnrolee,
            stepUpTotp,
            stepUpPassword,
            dialogOwner,
          },
          links: {
            invitation: { email: inviteeEmail, link: invitationLink, password: randomPassword() },
            passwordReset: {
              email: resetWithoutMfa.email,
              link: passwordResetLink,
              newPassword: randomPassword(),
            },
            passwordResetWithMfa: {
              email: resetWithMfa.email,
              link: passwordResetWithMfaLink,
              newPassword: randomPassword(),
            },
          },
          catalog: catalogA,
        },
        b: {
          id: tenantBId,
          name: adminB.organizationName,
          slug: adminB.organizationSlug,
          users: { admin: b.user },
          catalog: catalogB,
        },
      },
    };

    // Written once, readable by its owner only; the content is never printed.
    writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(target, 0o600);
    return result;
  } finally {
    await built.close();
  }
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  try {
    await seed();
    process.stdout.write('e2e seed written to the state directory.\n');
  } catch (error: unknown) {
    // Only the message, which names a step, a status and a code: never a value.
    process.stderr.write(
      `e2e seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}
