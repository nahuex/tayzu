/**
 * `043` task 4.6b: `scripts/ci/dast.sh` follows the moved bootstrap CLI. The
 * script is read as text, like `zap-seed.test.ts` reads the workflow (it needs
 * Docker, so it cannot run here).
 *
 * - The seed receives the `tayzu_app` `DATABASE_URL` and the `tayzu_auth`
 *   `AUTH_DATABASE_URL` as two distinct values, with the Cerbos address, the
 *   origins and a fixed CI operator id as `TAYZU_OPERATOR_ID` (Resolved decision
 *   Q116).
 * - `EMAIL_PROVIDER=none` is exported (6.5, Resolved decision Q96).
 *
 * No production symbol is needed: the test reads `scripts/ci/dast.sh`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = readFileSync(
  fileURLToPath(new URL('../../../scripts/ci/dast.sh', import.meta.url)),
  'utf8',
);

/** The `up` function, where the seed runs. */
function upFunction(): string {
  const start = script.indexOf('\nup() {');
  const end = script.indexOf('\n# Loads the seeded session header');
  if (start === -1 || end === -1)
    throw new Error('dast.sh no longer has the shape this test reads');
  return script.slice(start, end);
}

/** The seed invocation (not the `--refresh` one) and everything that precedes it in `up`. */
function seedCommand(): { before: string; command: string } {
  const up = upFunction();
  const at = up.indexOf('scripts/ci/zap-seed.ts');
  if (at === -1) throw new Error('dast.sh no longer runs the seed in up()');
  const lineStart = up.lastIndexOf('log "seeding an organization and a session"', at);
  return {
    before: up.slice(0, lineStart),
    command: up.slice(lineStart, up.indexOf('\n  # What', at)),
  };
}

describe('dast.sh follows the moved bootstrap CLI (task 4.6b)', () => {
  it('the seed no longer receives the tayzu_auth URL as its DATABASE_URL', () => {
    const { command } = seedCommand();

    expect(command).not.toMatch(/DATABASE_URL="?\$\{?AUTH_DATABASE_URL/);
  });

  it('the seed receives distinct DATABASE_URL (tayzu_app) and AUTH_DATABASE_URL (tayzu_auth)', () => {
    const { before } = seedCommand();

    const exportedDatabaseUrls = [...before.matchAll(/export DATABASE_URL="([^"\n]+)"/g)].map(
      (match) => match[1],
    );
    const lastDatabaseUrl = exportedDatabaseUrls.at(-1);
    const authDatabaseUrl = /export AUTH_DATABASE_URL="([^"\n]+)"/.exec(before)?.[1];

    expect(lastDatabaseUrl).toContain('tayzu_app');
    expect(authDatabaseUrl).toContain('tayzu_auth');
    expect(lastDatabaseUrl).not.toBe(authDatabaseUrl);
  });

  it('the seed receives the Cerbos address, the origins and a fixed CI operator id', () => {
    const { before, command } = seedCommand();
    const visible = `${before}\n${command}`;

    expect(visible).toMatch(/export CERBOS_ADDRESS\b/);
    expect(visible).toMatch(/export ALLOWED_ORIGINS=/);
    expect(visible).toMatch(/TAYZU_OPERATOR_ID=["']?[A-Za-z0-9_.:-]{1,128}["']?(\s|$)/);
    expect(visible).not.toMatch(/TAYZU_OPERATOR_ID=["']?[^"'\s]*@/);
  });

  it('EMAIL_PROVIDER=none is exported', () => {
    expect(upFunction()).toMatch(/^\s*export EMAIL_PROVIDER=["']?none["']?\s*$/m);
  });

  it('IDENTITY_TOKEN_HMAC_SECRET is generated and exported without being printed (task 6.7b)', () => {
    const up = upFunction();

    expect(up).toMatch(/^\s*export IDENTITY_TOKEN_HMAC_SECRET="[^"\n]+"\s*$/m);
    expect(up).not.toMatch(/(echo|printf|log)[^\n]*IDENTITY_TOKEN_HMAC_SECRET/);
  });

  it('INVITATION_LINK_BASE_URL is exported equal to the ALLOWED_ORIGINS value, port included (task 6.7b)', () => {
    const up = upFunction();
    const allowed = /^\s*export ALLOWED_ORIGINS="([^"\n]+)"\s*$/m.exec(up)?.[1];
    const link = /^\s*export INVITATION_LINK_BASE_URL="([^"\n]+)"\s*$/m.exec(up)?.[1];

    expect(allowed).toBe('https://localhost:${API_PORT}');
    expect(link).toBe(allowed);
  });

  it('the --refresh call of api-scan keeps DATABASE_URL=unused and gains no new variable', () => {
    const refresh = /DATABASE_URL=unused[^\n]*\n[^\n]*zap-seed\.ts --refresh/.exec(script);

    expect(refresh).not.toBeNull();
    expect(script).not.toMatch(/TAYZU_OPERATOR_ID=[^\n]*--refresh/);
  });
});
