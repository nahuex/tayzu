/**
 * Unit test for `043` task 16.7 (SEC01): `docs/architecture/system-diagram.md`
 * shows the identity-lifecycle surfaces, actors and jobs, and every new arrow
 * carries its protocol. The test reads the Mermaid source of the document.
 *
 * Design D9 (jobs, their own Cerbos sidecar on a loopback link without TLS,
 * `tayzu_auth` and `tayzu_app`) and D10 (the fourteen routes). `045` adds the
 * fourteenth oRPC procedure (`DELETE /v1/organization`), so it is not required
 * here.
 *
 * This file lives in `apps/api/src` only because the Vitest projects glob
 * `src/**`; the document is outside every package (like `config.test.ts`
 * reading `docs/security/secrets.md`).
 *
 * ## Production symbols expected
 *
 * None: the change is the Markdown document. The "Mermaid block still renders"
 * clause of the task is checked by hand with `npx -y @mermaid-js/mermaid-cli`;
 * here only a structural sanity check (balanced `subgraph`/`end`) runs.
 *
 * ## Why this fails right now
 *
 * The diagram has none of the new nodes or arrows (assertion failures only).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const DOC_PATH = fileURLToPath(
  new URL('../../../docs/architecture/system-diagram.md', import.meta.url),
);

/** Every route of design D10 that exists in this change (045's delete excluded). */
const ROUTES = [
  'POST /v1/users/invitations',
  'POST /v1/users/invitations/{invitation}/cancel',
  'POST /v1/users/invitations/{invitation}/resend',
  'POST /v1/auth/invitations/accept',
  'PUT /v1/users/{user}/status',
  'POST /v1/users',
  'POST /v1/users/{user}/sso-account',
  'DELETE /v1/users/{user}/sso-account',
  'POST /v1/service-accounts',
  'DELETE /v1/service-accounts/{user}',
  'GET /v1/credentials',
  'POST /v1/credentials',
  'POST /v1/credentials/{credential}/rotate',
  'POST /v1/credentials/{credential}/revoke',
] as const;

/** A protocol token (SEC01): what an arrow must name. */
const PROTOCOL =
  /HTTPS|HTTP\b|gRPC|SMTP|in-process|PostgreSQL|Redis|OTLP|MCP|job pickup|wire protocol|CLI|protocol/i;

interface Edge {
  src: string;
  dst: string;
  label: string;
  /** Source label + arrow label + target label, <br/> flattened. */
  text: string;
  srcId: string;
  dstId: string;
}

function readMermaid(): string {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const match = /```mermaid\n([\s\S]*?)\n```/.exec(doc);
  if (!match?.[1]) throw new Error('no mermaid block in system-diagram.md');
  return match[1];
}

function flatten(text: string): string {
  return text.replace(/<br\s*\/?>/gi, ' ');
}

function parse(source: string): { nodes: Map<string, string>; edges: Edge[]; unparsed: string[] } {
  const nodes = new Map<string, string>();
  const edges: Edge[] = [];
  const unparsed: string[] = [];
  for (const line of source.split('\n')) {
    const arrow = line.includes('-->') || line.includes('-.->');
    if (arrow) {
      const labeled = /^\s*(\w+)\s+(?:-->|-\.->)\|"([^"]*)"\|\s*(\w+)\s*$/.exec(line);
      const bare = /^\s*(\w+)\s+(?:-->|-\.->)\s*(\w+)\s*$/.exec(line);
      const srcId = labeled?.[1] ?? bare?.[1];
      const dstId = labeled?.[3] ?? bare?.[2];
      if (srcId === undefined || dstId === undefined) {
        unparsed.push(line.trim());
        continue;
      }
      const label = flatten(labeled?.[2] ?? '');
      edges.push({
        srcId,
        dstId,
        src: nodes.get(srcId) ?? srcId,
        dst: nodes.get(dstId) ?? dstId,
        label,
        text: '',
      });
      continue;
    }
    const node = /^\s*(?:subgraph\s+)?(\w+)(?:\(\[|\[\(|\[|\()"([^"]*)"/.exec(line);
    if (node?.[1] !== undefined && node[2] !== undefined) nodes.set(node[1], flatten(node[2]));
  }
  // Resolve labels after all nodes are known (an edge may precede a definition).
  return {
    nodes,
    edges: edges.map((e) => {
      const src = nodes.get(e.srcId) ?? e.srcId;
      const dst = nodes.get(e.dstId) ?? e.dstId;
      return { ...e, src, dst, text: `${src} | ${e.label} | ${dst}` };
    }),
    unparsed,
  };
}

const source = readMermaid();
const { nodes, edges, unparsed } = parse(source);

function find(pred: (e: Edge) => boolean): Edge[] {
  return edges.filter(pred);
}

function expectProtocol(matches: Edge[]): void {
  expect(matches.length).toBeGreaterThan(0);
  for (const e of matches) expect(e.label).toMatch(PROTOCOL);
}

describe('system diagram, 043 identity lifecycle (task 16.7)', () => {
  it('keeps a structurally sound Mermaid block (balanced subgraphs, every arrow parsed and labeled)', () => {
    const lines = source.split('\n').map((l) => l.trim());
    const opens = lines.filter((l) => l.startsWith('subgraph ')).length;
    const ends = lines.filter((l) => l === 'end').length;
    expect(opens).toBe(ends);
    expect(unparsed).toEqual([]);
    for (const e of edges) expect(e.label.trim(), e.text).not.toBe('');
  });

  it('draws the email provider, the invitee with their mailbox and the platform operator as actors', () => {
    const labels = [...nodes.values()];
    expect(labels.some((l) => /email provider/i.test(l))).toBe(true);
    expect(labels.some((l) => /invitee/i.test(l) && /mailbox/i.test(l))).toBe(true);
    expect(labels.some((l) => /platform operator/i.test(l))).toBe(true);
  });

  it.each(ROUTES)('shows the route %s from design D10', (route) => {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(flatten(source)).toMatch(new RegExp(`${escaped}(?![\\w/{-])`));
  });

  it('has an arrow invite → email provider with its protocol', () => {
    expectProtocol(find((e) => /email provider/i.test(e.dst) && /invit/i.test(e.text)));
  });

  it('has an arrow email provider → invitee mailbox with its protocol', () => {
    expectProtocol(find((e) => /email provider/i.test(e.src) && /invitee|mailbox/i.test(e.dst)));
  });

  it('has an arrow invitee → the public accept route over HTTPS', () => {
    const matches = find(
      (e) => /invitee/i.test(e.src) && e.dst.includes('/v1/auth/invitations/accept'),
    );
    expectProtocol(matches);
    expect(matches.some((e) => /HTTPS/i.test(e.label))).toBe(true);
  });

  it('has the ACS egress to the email provider over HTTPS', () => {
    const matches = find(
      (e) => /email provider/i.test(e.dst) && /ACS|Communication Services/i.test(e.text),
    );
    expectProtocol(matches);
    expect(matches.some((e) => /HTTPS/i.test(e.label))).toBe(true);
  });

  it('has the Pwned Passwords range query over HTTPS', () => {
    const matches = find((e) => /Pwned Passwords|pwnedpasswords/i.test(e.dst));
    expectProtocol(matches);
    expect(matches.some((e) => /HTTPS/i.test(e.label) && /range/i.test(e.label))).toBe(true);
  });

  it('has an arrow for credential rotation with its protocol', () => {
    expectProtocol(
      find((e) => /credential rotation|\/v1\/credentials\/\{credential\}\/rotate/i.test(e.text)),
    );
  });

  describe.each(['backfill', 'reconcile'] as const)('the %s job', (kind) => {
    const isJob = (label: string): boolean =>
      new RegExp(`${kind}.*job|job.*${kind}`, 'i').test(label);

    it('is started by the platform operator, with a protocol', () => {
      expectProtocol(find((e) => /platform operator/i.test(e.src) && isJob(e.dst)));
    });

    it('reaches PostgreSQL as tayzu_auth and tayzu_app', () => {
      const out = find((e) => isJob(e.src) && /PostgreSQL/i.test(e.dst + e.label));
      expectProtocol(out);
      const text = out.map((e) => e.text).join(' ');
      expect(text).toContain('tayzu_auth');
      expect(text).toContain('tayzu_app');
    });

    it('reaches its own Cerbos sidecar over gRPC on a loopback link without TLS', () => {
      const out = find((e) => isJob(e.src) && /Cerbos/i.test(e.dst));
      expect(out).toHaveLength(1);
      const [edge] = out;
      expect(edge?.label).toMatch(/gRPC/i);
      expect(edge?.label).toMatch(/loopback|localhost|127\.0\.0\.1/i);
      expect(edge?.label).toMatch(/no TLS|without TLS/i);
      // Not the apps/api sidecar: a node of its own.
      expect(edge?.dstId).not.toBe('cerbos');
    });
  });

  it('gives each job a different Cerbos sidecar node', () => {
    const sidecar = (kind: string): string | undefined =>
      edges.find(
        (e) => new RegExp(`${kind}.*job|job.*${kind}`, 'i').test(e.src) && /Cerbos/i.test(e.dst),
      )?.dstId;
    const backfill = sidecar('backfill');
    const reconcile = sidecar('reconcile');
    expect(backfill).toBeDefined();
    expect(reconcile).toBeDefined();
    expect(backfill).not.toBe(reconcile);
  });

  it('gives every arrow whose text concerns a new surface a protocol', () => {
    const topic =
      /invit|accept|email provider|ACS|Communication Services|Pwned|credential|rotat|backfill|reconcile|sidecar|platform operator/i;
    const fresh = find((e) => topic.test(e.text));
    // At least the arrows the other tests require.
    expect(fresh.length).toBeGreaterThanOrEqual(10);
    for (const e of fresh) expect(e.label, e.text).toMatch(PROTOCOL);
  });
});
