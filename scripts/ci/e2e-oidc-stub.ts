/**
 * The OIDC stub of `@tayzu/auth` as Visma Connect, for the e2e stack (003 task 10.1,
 * design D16, Resolved decision Q38). `scripts/ci/e2e.sh up` starts it before the API:
 * it listens on 127.0.0.1:`E2E_OIDC_STUB_PORT` over plain HTTP, the TLS proxy serves it
 * at `E2E_OIDC_ISSUER` (an `https://127.0.0.1:<port>` origin, cross-site to the app, Q92), and that https issuer is
 * what its discovery document, its endpoints and its ID tokens name.
 *
 * Every authorization signs in as the run's Visma Connect user (`E2E_OIDC_SUBJECT`,
 * `E2E_OIDC_EMAIL`), the one the seed links to an account. The client id and secret are
 * the API's (`VISMA_CONNECT_CLIENT_ID`, `VISMA_CONNECT_CLIENT_SECRET`, random per run).
 * Nothing here prints a secret, a code or a token.
 */
import { randomBytes } from 'node:crypto';

import { startOidcStub } from '../../packages/auth/src/__fixtures__/oidc-stub.js';

type Env = Readonly<Record<string, string | undefined>>;

/** The display name the seed gives the Visma Connect user. */
const SSO_USER_NAME = 'E2E Visma Connect';

/** Fails closed naming the variable only, never its value. */
function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set: the e2e OIDC stub needs it.`);
  }
  return value.trim();
}

function port(env: Env, name: string): number {
  const raw = required(env, name);
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`${name} is malformed (a port is required).`);
  return Number(raw);
}

async function main(env: Env): Promise<void> {
  const stub = await startOidcStub({
    issuer: required(env, 'E2E_OIDC_ISSUER'),
    port: port(env, 'E2E_OIDC_STUB_PORT'),
    clientId: required(env, 'VISMA_CONNECT_CLIENT_ID'),
    clientSecret: required(env, 'VISMA_CONNECT_CLIENT_SECRET'),
  });
  const sub = required(env, 'E2E_OIDC_SUBJECT');
  const email = required(env, 'E2E_OIDC_EMAIL');
  // A session id makes the session a Visma Connect one (`ssoSid`), and every ID token
  // carries a fresh `auth_time`, an `acr` of 3 and an MFA `amr`, as a re-authorization
  // with Visma Connect would (002 step-up rules).
  const sid = `e2e-sid-${randomBytes(8).toString('hex')}`;
  const refresh = (): void => {
    stub.setSubject({
      sub,
      email,
      name: SSO_USER_NAME,
      sid,
      claims: { auth_time: Math.floor(Date.now() / 1000), acr: 3, amr: ['pwd', 'otp'] },
    });
  };
  refresh();
  setInterval(refresh, 1000).unref();
  process.stdout.write(`e2e-oidc-stub: listening on ${stub.localUrl}\n`);

  const stop = (): void => {
    void stub.close().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main(process.env).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'e2e-oidc-stub failed'}\n`);
  process.exitCode = 1;
});
