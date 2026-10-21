/**
 * The DAST probe of change 044 (design D17): hostile and well-formed requests against the
 * accept route and both password-reset routes of a running sandbox. It reports findings as a
 * kind and a path only, never a body or a sent value.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type ProbeFindingKind =
  | 'server_error'
  | 'stack_trace'
  | 'reflected_input'
  | 'missing_no_store'
  | 'known_unknown_difference';

export interface ProbeFinding {
  kind: ProbeFindingKind;
  path: string;
}

export interface ProbeResponse {
  path: string;
  status: number;
}

export interface ProbeOptions {
  /** Origin of the app, no trailing slash. */
  baseUrl: string;
  /** The allowed browser Origin sent on well-formed requests. */
  origin: string;
  /** An address with an eligible account (the request route). */
  knownEmail: string;
  fetch?: typeof fetch;
}

export interface ProbeResult {
  findings: ProbeFinding[];
  responses: ProbeResponse[];
}

const ACCEPT = '/v1/auth/invitations/accept';
const REQUEST = '/v1/auth/password-reset/request';
const CONFIRM = '/v1/auth/password-reset/confirm';
const RESET_ROUTES: readonly string[] = [REQUEST, CONFIRM];

/** Longer than the 1 MiB body limit. */
const OVERSIZED_LENGTH = 2 * 1024 * 1024;
const BURST_SIZE = 25;
const STACK_TRACE = /\bat\s+[^\n]*:\d+:\d+/;

/** A marker that must never come back in a response body. */
const CANARY = 'dast-probe-canary-7f3a9c1e';

interface Seen {
  path: string;
  status: number;
  headerNames: string;
  /** Whether the answer lacks `Cache-Control: no-store`. */
  missingNoStore: boolean;
  body: string;
}

interface Send {
  body: string;
  contentType?: string;
  csrf?: boolean;
  origin?: string;
}

const WELL_FORMED: Record<string, Record<string, string>> = {
  [ACCEPT]: { invitationId: CANARY, token: `${CANARY}-token`, password: `${CANARY}-Passw0rd!` },
  [REQUEST]: { email: `unknown-${CANARY}@example.com` },
  [CONFIRM]: { id: CANARY, token: `${CANARY}-token`, newPassword: `${CANARY}-Passw0rd!` },
};

export async function runDastProbe(options: ProbeOptions): Promise<ProbeResult> {
  const doFetch = options.fetch ?? fetch;
  const seen: Seen[] = [];

  async function send(path: string, request: Send): Promise<Seen> {
    const headers: Record<string, string> = {
      'content-type': request.contentType ?? 'application/json',
      origin: request.origin ?? options.origin,
    };
    if (request.csrf !== false) headers['x-csrf-token'] = '1';
    const response = await doFetch(`${options.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: request.body,
    });
    const names: string[] = [];
    response.headers.forEach((_value, name) => {
      names.push(name);
    });
    const entry: Seen = {
      path,
      status: response.status,
      headerNames: names.sort().join(','),
      missingNoStore: !(response.headers.get('cache-control') ?? '').includes('no-store'),
      body: await response.text(),
    };
    seen.push(entry);
    return entry;
  }

  for (const path of [ACCEPT, REQUEST, CONFIRM]) {
    const valid = JSON.stringify(WELL_FORMED[path]);
    const withKey = (key: string): string =>
      `{"${key}":{"${CANARY}":1},${JSON.stringify(WELL_FORMED[path]).slice(1)}`;
    await send(path, { body: valid });
    await send(path, { body: `{"${CANARY}` });
    await send(path, { body: `{"${CANARY}":"${'x'.repeat(OVERSIZED_LENGTH)}"}` });
    await send(path, { body: withKey('__proto__') });
    await send(path, { body: withKey('constructor') });
    await send(path, { body: valid, contentType: 'text/plain' });
    await send(path, { body: valid, csrf: false });
    await send(path, { body: valid, origin: 'https://evil.example' });
    if (path !== REQUEST) await send(path, { body: valid });
  }

  const knownBody = JSON.stringify({ email: options.knownEmail });
  const unknownBody = JSON.stringify({ email: `other-${CANARY}@example.com` });
  const known = await send(REQUEST, { body: knownBody });
  const unknown = await send(REQUEST, { body: unknownBody });
  for (let i = 0; i < BURST_SIZE; i += 1) {
    await send(REQUEST, { body: unknownBody });
  }

  const findings: ProbeFinding[] = [];
  const add = (kind: ProbeFindingKind, path: string): void => {
    if (!findings.some((f) => f.kind === kind && f.path === path)) findings.push({ kind, path });
  };

  for (const entry of seen) {
    if (entry.status >= 500) add('server_error', entry.path);
    if (STACK_TRACE.test(entry.body)) add('stack_trace', entry.path);
    if (entry.body.includes(CANARY) || entry.body.includes(options.knownEmail)) {
      add('reflected_input', entry.path);
    }
  }
  for (const entry of seen) {
    if (RESET_ROUTES.includes(entry.path) && entry.missingNoStore)
      add('missing_no_store', entry.path);
  }
  if (
    known.status !== unknown.status ||
    known.headerNames !== unknown.headerNames ||
    known.body !== unknown.body
  ) {
    add('known_unknown_difference', REQUEST);
  }

  return {
    findings,
    responses: seen.map(({ path, status }) => ({ path, status })),
  };
}

/**
 * Runs the probe against the stack of `dast.sh up` (task 14.2). Reads the target and origin the
 * seed already exports, writes the result to `DAST_PROBE_RESULT_FILE`, and exits 1 on a finding.
 * Output carries kinds and paths only.
 */
async function main(): Promise<void> {
  const env = process.env;
  const baseUrl = env['ZAP_TARGET_URL'];
  const origin = env['ZAP_SEED_ORIGIN'];
  const resultFile = env['DAST_PROBE_RESULT_FILE'];
  if (!baseUrl || !origin || !resultFile) {
    console.error('DAST probe needs ZAP_TARGET_URL, ZAP_SEED_ORIGIN and DAST_PROBE_RESULT_FILE');
    process.exit(2);
  }
  const knownEmail = env['ZAP_SEED_ADMIN_EMAIL'] || 'zap-admin@example.test';
  const result = await runDastProbe({ baseUrl, origin, knownEmail });
  writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 });
  for (const finding of result.findings) {
    console.error(`DAST probe finding: ${finding.kind} ${finding.path}`);
  }
  if (result.findings.length > 0) process.exit(1);
  console.log(`DAST probe: ${String(result.responses.length)} responses, no findings.`);
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  void main();
}
