/**
 * CI seed for the OWASP ZAP baseline job (task 15.1, design D16, resolved
 * decision Q30). Creates one organization and its first admin through
 * `packages/auth/scripts/bootstrap-admin.ts`, signs in over HTTP against the
 * already-running `apps/api` (started by the workflow with `main.ts`) and
 * writes the session cookie header ZAP replays (`ZAP_AUTH_HEADER`). It never
 * prints the one-time password, the secret or the cookie.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Env = Readonly<Record<string, string | undefined>>;

export interface ZapSeedConfig {
  databaseUrl: string;
  betterAuthSecret: string;
  /** http(s) origin of the running API, without a trailing slash. */
  baseUrl: string;
  /** The browser origin the seed claims, one of ALLOWED_ORIGINS; defaults to the target's. */
  origin: string;
  organizationName: string;
  organizationSlug: string;
  adminName: string;
  adminEmail: string;
}

/** Fails closed naming the variable only, never its value. */
function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set: zap-seed needs it to run.`);
  }
  return value;
}

function withDefault(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function parseTargetUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('ZAP_TARGET_URL is malformed (an http or https URL is required).');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ZAP_TARGET_URL is malformed (an http or https URL is required).');
  }
  return raw.trim().replace(/\/+$/, '');
}

export function parseZapSeedConfig(env: Env): ZapSeedConfig {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    betterAuthSecret: required(env, 'BETTER_AUTH_SECRET'),
    baseUrl: parseTargetUrl(required(env, 'ZAP_TARGET_URL')),
    origin: new URL(withDefault(env, 'ZAP_SEED_ORIGIN', required(env, 'ZAP_TARGET_URL'))).origin,
    organizationName: withDefault(env, 'ZAP_SEED_ORGANIZATION_NAME', 'ZAP Scan Organization'),
    organizationSlug: withDefault(env, 'ZAP_SEED_ORGANIZATION_SLUG', 'zap-scan'),
    adminName: withDefault(env, 'ZAP_SEED_ADMIN_NAME', 'ZAP Scan Admin'),
    adminEmail: withDefault(env, 'ZAP_SEED_ADMIN_EMAIL', 'zap-admin@example.test'),
  };
}

/** Keeps each `name=value` pair of the Set-Cookie values and drops attributes. */
export function buildZapAuthHeader(setCookie: readonly string[]): {
  name: 'Cookie';
  value: string;
} {
  const pairs = setCookie
    .map((entry) => (entry.split(';')[0] ?? '').trim())
    .filter((pair) => pair.includes('='));
  if (pairs.length === 0) {
    throw new Error('Sign-in returned no session cookie.');
  }
  return { name: 'Cookie', value: pairs.join('; ') };
}

export async function signInForSessionCookie(params: {
  baseUrl: string;
  email: string;
  password: string;
  fetch: typeof fetch;
  /** Defaults to the origin of `baseUrl`. */
  origin?: string;
}): Promise<string> {
  // Node's fetch sends `Sec-Fetch-Mode`, so Better Auth's form CSRF check
  // requires a trusted `Origin`, exactly as for a same-origin browser request.
  const response = await params.fetch(`${params.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: params.origin ?? new URL(params.baseUrl).origin,
    },
    body: JSON.stringify({ email: params.email, password: params.password }),
  });
  if (!response.ok) {
    const code = await readErrorCode(response);
    throw new Error(
      `Sign-in failed with status ${String(response.status)}${code === undefined ? '' : ` (${code})`}.`,
    );
  }
  return buildZapAuthHeader(response.headers.getSetCookie()).value;
}

/**
 * Better Auth's stable error code (for example `EMAIL_NOT_VERIFIED`), so a
 * failed seed names its cause. Only an upper-case identifier is kept: never
 * a message, never anything echoed from the request.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    const code = body?.code;
    return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Appends `ZAP_AUTH_HEADER=Cookie: ...` (and a masking directive) to the
 * file GitHub Actions exposes as `GITHUB_ENV`, or `ZAP_ENV_FILE` when set.
 */
function publishHeader(env: Env, cookie: string): void {
  const file = env['ZAP_ENV_FILE'] ?? env['GITHUB_ENV'];
  if (file === undefined || file === '') {
    throw new Error('GITHUB_ENV or ZAP_ENV_FILE is required to hand the header to ZAP.');
  }
  process.stdout.write(`::add-mask::${cookie}\n`);
  appendFileSync(file, `ZAP_AUTH_HEADER=Cookie\nZAP_AUTH_HEADER_VALUE=${cookie}\n`);
}

/**
 * Runs `packages/auth/scripts/bootstrap-admin.ts` as the operator would (it
 * resolves its own workspace dependencies) and reads the one-time password
 * from its output. The output is never echoed.
 */
function bootstrapFirstAdmin(config: ZapSeedConfig): string {
  const script = fileURLToPath(
    new URL('../../packages/auth/scripts/bootstrap-admin.ts', import.meta.url),
  );
  const output = execFileSync('pnpm', ['--filter', '@tayzu/auth', 'exec', 'tsx', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      BETTER_AUTH_SECRET: config.betterAuthSecret,
      BOOTSTRAP_ORGANIZATION_NAME: config.organizationName,
      BOOTSTRAP_ORGANIZATION_SLUG: config.organizationSlug,
      BOOTSTRAP_ADMIN_NAME: config.adminName,
      BOOTSTRAP_ADMIN_EMAIL: config.adminEmail,
    },
  });
  const password = /temporary password and change it immediately: (\S+)/.exec(output)?.[1];
  if (password === undefined) {
    throw new Error('The seed organization already exists: use a fresh database.');
  }
  return password;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;

function decodeBase32(encoded: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded.replace(/=+$/, '').toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error('The TOTP secret is not base32.');
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as an authenticator app computes it. */
export function totpCode(base32Secret: string, unixSeconds: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / TOTP_STEP_SECONDS)));
  const digest = createHmac('sha1', decodeBase32(base32Secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 1_000_000).toString().padStart(6, '0');
}

interface SeedClient {
  readonly baseUrl: string;
  readonly origin: string;
  readonly fetch: typeof fetch;
}

/** A same-origin JSON POST to a Better Auth route; fails naming only the status and code. */
async function postAuth(
  client: SeedClient,
  path: string,
  body: unknown,
  cookie: string | undefined,
): Promise<Response> {
  const response = await client.fetch(`${client.baseUrl}/api/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: client.origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const code = await readErrorCode(response);
    throw new Error(
      `${path} failed with status ${String(response.status)}${code === undefined ? '' : ` (${code})`}.`,
    );
  }
  return response;
}

function cookiesOf(response: Response, previous: string): string {
  const set = response.headers.getSetCookie();
  return set.length === 0 ? previous : buildZapAuthHeader(set).value;
}

async function waitForNextTotpStep(): Promise<number> {
  const now = Date.now() / 1000;
  const next = (Math.floor(now / TOTP_STEP_SECONDS) + 1) * TOTP_STEP_SECONDS;
  await new Promise((resolve) => setTimeout(resolve, (next - now) * 1000 + 250));
  return Date.now() / 1000;
}

/**
 * Task 24.9 (design Q56, Q43): an organization admin without MFA only gets a
 * session limited to MFA enrollment, so the scan would see nothing but
 * `AUTH_STEP_UP_REQUIRED`. The seed enrolls a TOTP factor over HTTP, as the
 * admin would, then signs in again with it and returns that fresh MFA
 * session's cookie.
 */
export async function mfaSessionCookie(
  client: SeedClient,
  credentials: { readonly email: string; readonly password: string },
): Promise<string> {
  const enrollment = await signInForSessionCookie({ ...client, ...credentials });
  const enabled = await postAuth(
    client,
    '/two-factor/enable',
    { password: credentials.password },
    enrollment,
  );
  const { totpURI } = (await enabled.json()) as { totpURI?: unknown };
  const secret = typeof totpURI === 'string' ? new URL(totpURI).searchParams.get('secret') : null;
  if (secret === null) {
    throw new Error('/two-factor/enable returned no TOTP secret.');
  }
  await postAuth(
    client,
    '/two-factor/verify-totp',
    { code: totpCode(secret, Date.now() / 1000) },
    cookiesOf(enabled, enrollment),
  );

  const challenge = await postAuth(client, '/sign-in/email', credentials, undefined);
  // A fresh time step, so the sign-in code is never the enrollment code.
  const now = await waitForNextTotpStep();
  const verified = await postAuth(
    client,
    '/two-factor/verify-totp',
    { code: totpCode(secret, now) },
    cookiesOf(challenge, ''),
  );
  return cookiesOf(verified, '');
}

/** Fails the seed unless the cookie really reaches the catalog, as the scan will. */
async function assertCatalogReachable(client: SeedClient, cookie: string): Promise<void> {
  const response = await client.fetch(`${client.baseUrl}/v1/blueprints`, {
    headers: { cookie },
  });
  if (response.status !== 200) {
    const code = await readErrorCode(response);
    throw new Error(
      `The seeded session cannot read /v1/blueprints: status ${String(response.status)}${code === undefined ? '' : ` (${code})`}.`,
    );
  }
}

async function main(): Promise<void> {
  const config = parseZapSeedConfig(process.env);
  const client: SeedClient = { baseUrl: config.baseUrl, origin: config.origin, fetch };
  const cookie = await mfaSessionCookie(client, {
    email: config.adminEmail,
    password: bootstrapFirstAdmin(config),
  });
  await assertCatalogReachable(client, cookie);
  publishHeader(process.env, cookie);
  console.log('ZAP session seeded (MFA-enrolled admin, catalog reachable).');
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  await main();
}
