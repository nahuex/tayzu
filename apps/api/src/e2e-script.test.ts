/**
 * `003` task 10.1 (design D16, D2, Resolved decision Q38): `scripts/ci/e2e.sh`
 * starts the e2e stack the Playwright suite of `apps/web/e2e/` runs against. It
 * needs Docker and a browser, so, like `dast-script.test.ts`, the script is read
 * as text.
 *
 * ## Contract (red phase: neither script exists yet)
 *
 * `scripts/ci/e2e.sh`:
 *
 * - Subcommands `up`, `test`, `down` and `all` (`all`: `trap down EXIT`, `up`, then
 *   what `test` runs), and a usage line `usage: e2e.sh up|test|down|all`. The
 *   `test` subcommand runs Playwright for `@tayzu/web` (`playwright test` or the
 *   package's `e2e` script); it never defines a shell function named `test`.
 * - Exit 77 without Docker, before the dispatcher (`pnpm ci:local` counts 77 as SKIP).
 * - `STATE_DIR` defaults outside the repository and is `chmod 700`; it is exported
 *   as `E2E_STATE_DIR`, the directory the seed writes `seed.json` to and the shared
 *   fixture reads it from.
 * - One throwaway CA per run (`openssl req -x509`, `CA:TRUE`), whose key is deleted
 *   once the last certificate is signed; PostgreSQL 18 with `ssl=on`; every database
 *   URL carries `sslmode=verify-full&sslrootcert=`; nothing relaxes TLS.
 * - Images pinned by digest through `pinned_image`, which reads
 *   `scripts/ci/Dockerfile.images`; no image tag is written in the script.
 * - `export NODE_ENV=production` before `apps/api` starts; no other value.
 * - `export WEB_DIST_DIR="$REPO_ROOT/apps/web/dist"` once, after
 *   `pnpm --filter @tayzu/web build`, before `apps/api` starts;
 *   `export MOUNT_IDENTITY_ROUTES=true`; `export EMAIL_PROVIDER=none`;
 *   `export HOST="127.0.0.1"`.
 * - `BETTER_AUTH_URL`, the first `ALLOWED_ORIGINS` entry,
 *   `INVITATION_LINK_BASE_URL` and `PASSWORD_RESET_LINK_BASE_URL` are the same
 *   `https://localhost:<port>` origin: the proxy's.
 * - The OIDC stub of `@tayzu/auth` (`packages/auth/src/__fixtures__/oidc-stub.ts`)
 *   runs through `scripts/ci/e2e-oidc-stub.ts`; `VISMA_CONNECT_DISCOVERY_URL` is an
 *   `https://127.0.0.1:` URL (behind the proxy): the stub must be cross-site to the
 *   app at `localhost`, as Visma Connect is in production (Resolved decision Q92), so
 *   its `form_post` callback carries no `SameSite=Lax` cookie.
 *   `VISMA_CONNECT_CLIENT_SECRET` is random per run. `E2E_OIDC_SUBJECT` and
 *   `E2E_OIDC_EMAIL` are exported for the stub and the seed.
 * - The test-only TLS reverse proxy is `scripts/ci/e2e-tls-proxy.ts`: `node:https`,
 *   bound to `127.0.0.1`, with a `localhost` certificate signed by the same CA.
 * - The seed `apps/web/e2e/fixtures/seed.ts` runs after `apps/api` is healthy and the
 *   proxy is started, with `DATABASE_URL` (`tayzu_app`), `AUTH_DATABASE_URL`
 *   (`tayzu_auth`) and a fixed `TAYZU_OPERATOR_ID`.
 * - No generated secret, database URL, credential or seed output is ever echoed:
 *   every `$(openssl rand …)` value is masked with `::add-mask::`, no `echo`,
 *   `printf`, `log` or `fail` line names one (except into a pipe to `docker exec -i`
 *   or a redirect into `$STATE_DIR`), no `set -x`, and `seed.json` is never read by
 *   the shell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT_PATH = join(repoRoot, 'scripts', 'ci', 'e2e.sh');
const PROXY_PATH = join(repoRoot, 'scripts', 'ci', 'e2e-tls-proxy.ts');
const STUB_RUNNER_PATH = join(repoRoot, 'scripts', 'ci', 'e2e-oidc-stub.ts');
const IMAGES_PATH = join(repoRoot, 'scripts', 'ci', 'Dockerfile.images');

/** Reads a file of the stack, so a missing one fails each case with its own path. */
function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function script(): string {
  return read(SCRIPT_PATH);
}

/**
 * The lines the shell runs: comments and blank lines dropped, `\` continuations and
 * pipelines broken after a trailing `|` joined into one line.
 */
function codeLines(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, ' ')
    .replace(/\|\n\s*/g, '| ')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/** The body of a top-level shell function `name() { … }`, up to its closing `}`. */
function shellFunction(name: string): string {
  const text = script();
  const start = text.indexOf(`\n${name}() {`);
  if (start === -1) throw new Error(`e2e.sh has no ${name}() function`);
  const end = text.indexOf('\n}\n', start);
  if (end === -1) throw new Error(`e2e.sh: ${name}() is not closed`);
  return text.slice(start, end);
}

/** The lines of one `label)` case of the dispatcher, up to its `;;`. */
function dispatcherCase(label: string): string {
  const text = script();
  const match = new RegExp(`\\n\\s*${label}\\)`).exec(text);
  if (match === null) throw new Error(`e2e.sh has no ${label}) case`);
  const end = text.indexOf(';;', match.index);
  return text.slice(match.index, end === -1 ? undefined : end);
}

/** The index, among `lines`, of the first line matching `pattern`. */
function lineIndex(lines: readonly string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

const API_START = /--filter[= ]@tayzu\/api\s+start\b/;
const SEED_RUN = /apps\/web\/e2e\/fixtures\/seed\.ts/;
const PROXY_RUN = /scripts\/ci\/e2e-tls-proxy\.ts/;
const STUB_RUN = /scripts\/ci\/e2e-oidc-stub\.ts/;

/** The `export NAME="value"` values of `up`, in order. */
function exportedValues(name: string): string[] {
  return [
    ...shellFunction('up').matchAll(
      new RegExp(`^\\s*export ${name}=["']?([^"'\\n]*)["']?\\s*$`, 'gm'),
    ),
  ].map((match) => match[1] ?? '');
}

describe('e2e.sh: the subcommands (task 10.1)', () => {
  it('the dispatcher has up, test, down and all, and a usage line naming them', () => {
    const text = script();

    expect(text).toMatch(/^\s*up\) up ;;\s*$/m);
    expect(text).toMatch(/^\s*down\) down ;;\s*$/m);
    expect(text).toMatch(/^\s*test\) [a-z_]+ ;;\s*$/m);
    expect(text).toMatch(/usage: e2e\.sh up\|test\|down\|all/);
    // `test` is a shell builtin: the subcommand never shadows it with a function.
    expect(text).not.toMatch(/^test\(\) \{/m);
  });

  it('test runs the Playwright suite of @tayzu/web', () => {
    const command = /^\s*test\) ([a-z_]+) ;;\s*$/m.exec(script())?.[1] ?? '';
    expect(command).not.toBe('');

    expect(shellFunction(command)).toMatch(
      /playwright test|--filter[= ]@tayzu\/web\s+(run\s+)?e2e\b/,
    );
  });

  it('all stops the stack on exit, starts it, then runs what test runs', () => {
    const command = /^\s*test\) ([a-z_]+) ;;\s*$/m.exec(script())?.[1] ?? '';
    const all = dispatcherCase('all');

    const trapAt = all.search(/^\s*trap down EXIT\s*$/m);
    const upAt = all.search(/^\s*up\s*$/m);
    const testAt = all.search(new RegExp(`^\\s*${command}\\s*$`, 'm'));
    expect(trapAt).toBeGreaterThan(-1);
    expect(upAt).toBeGreaterThan(trapAt);
    expect(testAt).toBeGreaterThan(upAt);
  });

  it('exits 77 without Docker, before the dispatcher, like dast.sh', () => {
    const text = script();
    const check = /if ! docker info >\/dev\/null 2>&1; then\n[^\n]*\n\s*exit 77\n\s*fi/.exec(text);

    expect(check).not.toBeNull();
    expect(check?.index ?? Infinity).toBeLessThan(text.search(/\ncase "\$\{1:-\}" in/));
  });

  it('the state directory is outside the repository, private and exported as E2E_STATE_DIR', () => {
    const text = script();
    const assignment = /^STATE_DIR="([^"\n]+)"$/m.exec(text)?.[1];

    expect(assignment).toBeDefined();
    expect(assignment).not.toMatch(/REPO_ROOT|SCRIPT_DIR|^\.|^apps\//);
    expect(text).toMatch(/^export E2E_STATE_DIR="\$STATE_DIR"$/m);
    expect(shellFunction('up')).toMatch(/^\s*chmod 700 "\$STATE_DIR"\s*$/m);
  });
});

describe('e2e.sh: the database and the proxy use verified TLS (task 10.1, Q38)', () => {
  it('one throwaway CA per run, whose key is deleted after the last certificate is signed', () => {
    const lines = codeLines(script());
    const caLines = lines.filter((line) => /openssl req\b[^\n]*-x509/.test(line));

    expect(caLines).toHaveLength(1);
    expect(caLines[0]).toMatch(/basicConstraints=critical,CA:TRUE/);
    const lastSign = lines.reduce(
      (last, line, index) => (/openssl x509 -req\b[^\n]*-CAkey/.test(line) ? index : last),
      -1,
    );
    const removeKey = lines.findIndex(
      (line, index) => index > lastSign && /^\s*rm -f\b[^\n]*ca\.key/.test(line),
    );
    expect(lastSign).toBeGreaterThan(-1);
    expect(removeKey).toBeGreaterThan(lastSign);
  });

  it('every signed certificate is for localhost and signed by that one CA', () => {
    const text = script();
    const signs = codeLines(text).filter((line) => /openssl x509 -req\b/.test(line));

    expect(signs.length).toBeGreaterThan(0);
    for (const line of signs) expect(line).toMatch(/-CA "\$[A-Za-z_{}]+\/ca\.crt"/);
    expect(text).toMatch(/subjectAltName=DNS:localhost/);
  });

  it('PostgreSQL 18 runs with ssl=on and every database URL is sslmode=verify-full with the CA', () => {
    const text = script();
    const urls = [...text.matchAll(/postgres(?:ql)?:\/\/[^\s"']+/g)].map((match) => match[0]);

    expect(text).toMatch(/-c ssl=on\b/);
    expect(urls.length).toBeGreaterThan(0);
    expect(text).toMatch(/sslmode=verify-full&sslrootcert=\$\{?STATE_DIR\}?\/tls\/ca\.crt/);
    for (const url of urls) expect(url, url).toMatch(/\?\$\{?[a-z_]+\}?$|sslmode=verify-full/);
    expect(text).not.toMatch(/sslmode=(disable|allow|prefer|require|verify-ca)\b/);
  });

  it('nothing relaxes TLS anywhere in the stack', () => {
    for (const path of [SCRIPT_PATH, PROXY_PATH, STUB_RUNNER_PATH]) {
      const text = read(path);
      expect(text, path).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
      expect(text, path).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(text, path).not.toMatch(/--insecure\b|\bcurl\b[^\n]*\s-k\b/);
      expect(text, path).not.toMatch(/ignoreHTTPSErrors/);
    }
  });

  it('the proxy is a node:https server on 127.0.0.1 with the localhost certificate', () => {
    const proxy = read(PROXY_PATH);

    expect(proxy).toMatch(/from 'node:https'/);
    expect(proxy).toMatch(/\bcreateServer\(/);
    expect(proxy).toMatch(/\bkey\s*:/);
    expect(proxy).toMatch(/\bcert\s*:/);
    expect(proxy).toContain('127.0.0.1');
    expect(proxy).not.toContain('0.0.0.0');
  });

  it('up() starts the proxy with a certificate from the state directory', () => {
    const up = codeLines(shellFunction('up'));
    const proxyLine = up.find((line) => PROXY_RUN.test(line)) ?? '';

    expect(proxyLine).not.toBe('');
    const visible = up.join('\n');
    expect(visible).toMatch(/\$\{?STATE_DIR\}?\/tls\/[A-Za-z_-]+\.crt/);
    expect(visible).toMatch(/\$\{?STATE_DIR\}?\/tls\/[A-Za-z_-]+\.key/);
  });

  it('the API listens on 127.0.0.1 only, and nothing binds every interface', () => {
    expect(exportedValues('HOST')).toEqual(['127.0.0.1']);
    expect(script()).not.toContain('0.0.0.0');
  });
});

describe('e2e.sh: the images are pinned by digest (task 10.1)', () => {
  it('the PostgreSQL image comes from Dockerfile.images, pinned by digest', () => {
    const text = script();

    expect(text).toMatch(/\$SCRIPT_DIR\/Dockerfile\.images/);
    expect(text).toMatch(/^PG_IMAGE="[^"\n]*\$\(pinned_image postgres\)[^"\n]*"$/m);
    expect(read(IMAGES_PATH)).toMatch(/^FROM postgres:18@sha256:[0-9a-f]{64} AS postgres$/m);
  });

  it('no image reference is written in the script itself', () => {
    const lines = codeLines(script());

    expect(lines.join('\n')).not.toMatch(/\b(postgres|cerbos|zaproxy):[0-9A-Za-z.-]+/);
    expect(lines.join('\n')).not.toMatch(/@sha256:/);
    for (const line of lines.filter((candidate) => /\bdocker (run|pull)\b/.test(candidate))) {
      expect(line).toMatch(/"\$\{?[A-Z_]+_IMAGE\}?"/);
    }
  });
});

describe('e2e.sh: the API runs with its production configuration (task 10.1, D16)', () => {
  it('NODE_ENV is exported as production before apps/api starts, and is never test', () => {
    const text = script();
    const up = codeLines(shellFunction('up'));
    const exportAt = lineIndex(up, /^\s*export NODE_ENV=["']?production["']?\s*$/);

    expect(exportAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(lineIndex(up, API_START));
    const assignments = [...text.matchAll(/NODE_ENV=["']?([^"'\s]*)/g)].map((match) => match[1]);
    for (const value of assignments) expect(value).toBe('production');
    expect(text).not.toMatch(/NODE_ENV[^\n]*\btest\b/);
  });

  it('builds @tayzu/web, then exports WEB_DIST_DIR once, before apps/api starts', () => {
    const up = codeLines(shellFunction('up'));
    const buildAt = lineIndex(up, /\bpnpm\b[^\n]*--filter[= ]@tayzu\/web\s+(run\s+)?build\b/);
    const exportAt = lineIndex(up, /^\s*export WEB_DIST_DIR=/);
    const apiAt = lineIndex(up, API_START);

    expect(buildAt).toBeGreaterThan(-1);
    expect(up[buildAt]).not.toMatch(/&\s*$|\|\|/);
    expect(up[exportAt]).toMatch(
      /^\s*export WEB_DIST_DIR="\$\{?REPO_ROOT\}?\/apps\/web\/dist\/?"\s*$/,
    );
    expect(buildAt).toBeLessThan(exportAt);
    expect(exportAt).toBeLessThan(apiAt);
    expect([...script().matchAll(/\bWEB_DIST_DIR=/g)]).toHaveLength(1);
  });

  it('exports MOUNT_IDENTITY_ROUTES=true and EMAIL_PROVIDER=none, and no other provider', () => {
    expect(exportedValues('MOUNT_IDENTITY_ROUTES')).toEqual(['true']);
    expect(exportedValues('EMAIL_PROVIDER')).toEqual(['none']);
    const providers = [...script().matchAll(/EMAIL_PROVIDER=["']?([^"'\s]*)/g)].map((m) => m[1]);
    for (const value of providers) expect(value).toBe('none');
  });

  it('the public URL, the first allowed origin and both link bases are the proxy https origin', () => {
    const [publicUrl] = exportedValues('BETTER_AUTH_URL');
    const [origins] = exportedValues('ALLOWED_ORIGINS');
    const [invitation] = exportedValues('INVITATION_LINK_BASE_URL');
    const [reset] = exportedValues('PASSWORD_RESET_LINK_BASE_URL');

    expect(publicUrl).toMatch(/^https:\/\/localhost:\$\{?[A-Z_]+\}?$/);
    expect(origins?.split(',')[0]).toBe(publicUrl);
    for (const origin of origins?.split(',') ?? []) expect(origin).toMatch(/^https:\/\//);
    expect(invitation).toBe(publicUrl);
    expect(reset).toBe(publicUrl);
  });

  it('the OIDC stub of @tayzu/auth stands in for Visma Connect, behind the proxy', () => {
    const up = codeLines(shellFunction('up'));
    const stubAt = lineIndex(up, STUB_RUN);
    const [discovery] = exportedValues('VISMA_CONNECT_DISCOVERY_URL');

    expect(stubAt).toBeGreaterThan(-1);
    expect(stubAt).toBeLessThan(lineIndex(up, API_START));
    expect(read(STUB_RUNNER_PATH)).toMatch(
      /from '(\.\.\/)+packages\/auth\/src\/__fixtures__\/oidc-stub\.js'/,
    );
    // Q92: cross-site to the app (`localhost`), so `127.0.0.1`, never `localhost`.
    expect(discovery).toMatch(
      /^https:\/\/127\.0\.0\.1:[^\n]*\/\.well-known\/openid-configuration$/,
    );
    expect(exportedValues('VISMA_CONNECT_CLIENT_ID')).toHaveLength(1);
    expect(exportedValues('VISMA_CONNECT_CLIENT_SECRET')).toHaveLength(1);
    expect(exportedValues('E2E_OIDC_SUBJECT')).toHaveLength(1);
    expect(exportedValues('E2E_OIDC_EMAIL')).toHaveLength(1);
  });

  it('the seed runs after apps/api and the proxy, with the runtime roles and a fixed operator id', () => {
    const upText = shellFunction('up');
    const up = codeLines(upText);
    const seedAt = lineIndex(up, SEED_RUN);

    expect(seedAt).toBeGreaterThan(lineIndex(up, API_START));
    expect(seedAt).toBeGreaterThan(lineIndex(up, PROXY_RUN));
    const before = up.slice(0, seedAt).join('\n');
    const databaseUrls = [...before.matchAll(/export DATABASE_URL="([^"\n]+)"/g)].map((m) => m[1]);
    const authUrl = /export AUTH_DATABASE_URL="([^"\n]+)"/.exec(before)?.[1];
    expect(databaseUrls.at(-1)).toContain('tayzu_app');
    expect(authUrl).toContain('tayzu_auth');
    expect(`${before}\n${up[seedAt] ?? ''}`).toMatch(
      /TAYZU_OPERATOR_ID=["']?[A-Za-z0-9_.:-]{1,128}["']?(\s|$)/,
    );
    expect(up[seedAt]).not.toMatch(/\|\s*tee\b|&\s*$/);
  });
});

/**
 * `048` task 2.4 (design D1, Resolved decision Q5): `db:migrate` reads only
 * `MIGRATION_DATABASE_URL`, so the script exports the owner URL under that name
 * before `pnpm db:migrate`, the TLS-readiness probe reads it, and the only
 * `DATABASE_URL` the script exports is the `tayzu_app` runtime URL, after the
 * migrate step.
 */
const MIGRATE_RUN = /\bpnpm db:migrate\b/;
const OWNER_URL = /^postgres:\/\/tayzu:/;
const APP_URL = /^postgres:\/\/tayzu_app:/;

/**
 * The value `raw` stands for at `lines[at]`: every `$name` or `${name}` in it, bare or
 * embedded, is replaced by the last plain or exported assignment of `name` before that
 * line, itself resolved the same way. A reference with no assignment is left as written.
 */
function resolveShellValue(lines: readonly string[], at: number, raw: string, depth = 0): string {
  if (depth > 5) return raw;
  return raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (reference: string, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      const assignment = new RegExp(
        `^\\s*(?:export\\s+|local\\s+)?${name}=["']?([^"'\\n]*)["']?\\s*$`,
      );
      for (let index = at - 1; index >= 0; index -= 1) {
        const value = assignment.exec(lines[index] ?? '')?.[1];
        if (value !== undefined) return resolveShellValue(lines, index, value, depth + 1);
      }
      return reference;
    },
  );
}

/** Every `export NAME=value` line among `lines`: its index and resolved value. */
function exportsOf(lines: readonly string[], name: string): { at: number; value: string }[] {
  const pattern = new RegExp(`^\\s*export ${name}=["']?([^"'\\n]*)["']?\\s*$`);
  return lines.flatMap((line, at) => {
    const raw = pattern.exec(line)?.[1];
    return raw === undefined ? [] : [{ at, value: resolveShellValue(lines, at, raw) }];
  });
}

/**
 * `048` task 3.1 (design D2): the stack runs with `NODE_ENV=production`, so `up()` sets
 * the proxy trust the API requires outside test: one hop, from the loopback addresses of
 * the local TLS proxy only, exported before `apps/api` starts.
 */
describe('e2e.sh: the API trusts one proxy hop from loopback only (048 task 3.1, design D2)', () => {
  it('exports TRUST_PROXY_HOPS=1 and TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128 once, before apps/api starts', () => {
    const up = codeLines(shellFunction('up'));
    const apiAt = lineIndex(up, API_START);
    const hopsAt = lineIndex(up, /^\s*export TRUST_PROXY_HOPS=/);
    const cidrsAt = lineIndex(up, /^\s*export TRUST_PROXY_CIDRS=/);

    expect(exportedValues('TRUST_PROXY_HOPS')).toEqual(['1']);
    expect(exportedValues('TRUST_PROXY_CIDRS')).toEqual(['127.0.0.1/32,::1/128']);
    expect(apiAt, 'a line that starts @tayzu/api in up()').toBeGreaterThan(-1);
    expect(hopsAt, 'an `export TRUST_PROXY_HOPS=` line in up()').toBeGreaterThan(-1);
    expect(cidrsAt, 'an `export TRUST_PROXY_CIDRS=` line in up()').toBeGreaterThan(-1);
    expect(hopsAt).toBeLessThan(apiAt);
    expect(cidrsAt).toBeLessThan(apiAt);
    expect([...script().matchAll(/\bTRUST_PROXY_HOPS=/g)]).toHaveLength(1);
    expect([...script().matchAll(/\bTRUST_PROXY_CIDRS=/g)]).toHaveLength(1);
  });
});

describe('e2e.sh: migrations run as the migration role (048 task 2.4, design D1)', () => {
  it('exports the owner URL as MIGRATION_DATABASE_URL before the pnpm db:migrate line', () => {
    const up = codeLines(shellFunction('up'));
    const migrateAt = lineIndex(up, MIGRATE_RUN);
    const migrationExports = exportsOf(up, 'MIGRATION_DATABASE_URL');

    expect(migrateAt, 'a `pnpm db:migrate` line in up()').toBeGreaterThan(-1);
    expect(migrationExports.length, 'an `export MIGRATION_DATABASE_URL=` line in up()').toBe(1);
    const [owner] = migrationExports;
    expect(owner?.value).toMatch(OWNER_URL);
    expect(owner?.value).toMatch(/sslmode=verify-full/);
    expect(owner?.at ?? Infinity).toBeLessThan(migrateAt);
    // The migrate step gets no inline DATABASE_URL either.
    expect(up[migrateAt]).not.toMatch(/\bDATABASE_URL=/);
  });

  it('the owner URL is never exported as DATABASE_URL: the only DATABASE_URL is tayzu_app, after the migrate step', () => {
    const lines = codeLines(script());
    const up = codeLines(shellFunction('up'));
    const migrateAt = lineIndex(up, MIGRATE_RUN);

    const everywhere = exportsOf(lines, 'DATABASE_URL');
    expect(everywhere.length, 'one `export DATABASE_URL=` line in the script').toBe(1);
    for (const { value } of everywhere) {
      expect(value).not.toMatch(OWNER_URL);
      expect(value).not.toMatch(/MIGRATION_DATABASE_URL/);
      expect(value).toMatch(APP_URL);
    }

    const inUp = exportsOf(up, 'DATABASE_URL');
    expect(inUp).toHaveLength(1);
    expect(inUp[0]?.at ?? -1).toBeGreaterThan(migrateAt);
  });

  it('the TLS-readiness probe reads MIGRATION_DATABASE_URL, exported before the probe runs', () => {
    const probe = shellFunction('postgres_accepts_tls');
    const up = codeLines(shellFunction('up'));
    const probeAt = lineIndex(up, /\bwait_for\b[^\n]*\bpostgres_accepts_tls\b/);
    const exportAt = exportsOf(up, 'MIGRATION_DATABASE_URL')[0]?.at ?? Infinity;

    expect(probe).toMatch(/connectionString:\s*process\.env\.MIGRATION_DATABASE_URL\b/);
    expect(probe).not.toMatch(/process\.env\.DATABASE_URL\b/);
    expect(probeAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(probeAt);
    expect(probeAt).toBeLessThan(lineIndex(up, MIGRATE_RUN));
  });
});

describe('turbo.json: db:migrate hashes only the migration variable (048 task 2.4, design D1)', () => {
  it('db:migrate.env is exactly ["MIGRATION_DATABASE_URL"]', () => {
    const turbo = JSON.parse(read(join(repoRoot, 'turbo.json'))) as {
      tasks?: Record<string, { env?: unknown; cache?: unknown }>;
    };
    const migrate = turbo.tasks?.['db:migrate'];

    expect(migrate, 'a db:migrate task in turbo.json').toBeDefined();
    expect(migrate?.env).toEqual(['MIGRATION_DATABASE_URL']);
    expect(migrate?.cache).toBe(false);
  });
});

describe('e2e.sh never echoes a secret, a credential or a link (task 10.1, D16)', () => {
  /** Variables assigned from `$(openssl rand …)` anywhere in the script. */
  function generatedSecrets(): string[] {
    return [...script().matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)="\$\(openssl rand\b/g)].map(
      (match) => match[1] ?? '',
    );
  }

  const ALWAYS_SECRET = [
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'AUTH_DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'IDENTITY_TOKEN_HMAC_SECRET',
    'VISMA_CONNECT_CLIENT_SECRET',
    'database_url',
  ];

  it('generates its secrets with openssl rand and masks every one', () => {
    const secrets = generatedSecrets();

    expect(secrets.length).toBeGreaterThanOrEqual(5);
    expect(shellFunction('mask')).toContain('echo "::add-mask::$1"');
    for (const name of secrets) {
      expect(script(), name).toMatch(new RegExp(`^\\s*mask "\\$\\{?${name}\\}?"\\s*$`, 'm'));
    }
  });

  it('no echo, printf, log or fail line names a secret, unless it feeds docker exec -i or a state file', () => {
    const names = [...new Set([...generatedSecrets(), ...ALWAYS_SECRET])];
    const lines = codeLines(script());

    for (const line of lines) {
      if (!/\b(echo|printf|log|fail)\b/.test(line)) continue;
      if (/^\s*echo "::add-mask::\$1"\s*$/.test(line)) continue;
      const fedPrivately =
        /\|\s*docker exec -i\b/.test(line) || /\s>>?\s*"\$\{?STATE_DIR\}?\//.test(line);
      for (const name of names) {
        if (new RegExp(`\\$\\{?${name}\\b`).test(line)) {
          expect(fedPrivately, `${name} reaches the output: ${line.trim()}`).toBe(true);
        }
      }
    }
  });

  it('never traces commands, and never reads the seed file in the shell', () => {
    const text = script();

    expect(text).not.toMatch(/^\s*set -[a-z]*x/m);
    expect(text).not.toMatch(/\bbash -x\b/);
    for (const line of codeLines(text).filter((candidate) => candidate.includes('seed.json'))) {
      expect(line).not.toMatch(/\b(cat|echo|printf|log|jq|head|tail|less|more)\b/);
    }
    // Nothing the seed writes is handed to the CI environment.
    expect(text).not.toMatch(/GITHUB_ENV/);
  });

  it('the stack scripts exist beside it', () => {
    expect(existsSync(PROXY_PATH), PROXY_PATH).toBe(true);
    expect(existsSync(STUB_RUNNER_PATH), STUB_RUNNER_PATH).toBe(true);
  });
});
