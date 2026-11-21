/**
 * Unit test for `043` task 16.7 (SEC01): `docs/architecture/system-diagram.md`
 * shows the identity-lifecycle surfaces, actors and jobs, and every new arrow
 * carries its protocol. The test reads the Mermaid source of the document.
 *
 * Design D9 (jobs, their own Cerbos sidecar on a loopback link without TLS,
 * `tayzu_auth` and `tayzu_app`) and D10 (the fourteen routes). `045` task 8.3
 * adds the fifteenth oRPC procedure (`DELETE /v1/organization`, behind the mount
 * switch), so the route list below moves by one.
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

/** Every route of design D10 that exists in this change, plus `045`'s org-deletion request. */
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
  // 045 task 8.3 (design D6): the org-deletion request, the fifteenth oRPC procedure.
  'DELETE /v1/organization',
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

/** Every Mermaid block of the document, in order: the full diagram, then the zones. */
function readMermaidBlocks(): string[] {
  const doc = readFileSync(DOC_PATH, 'utf8');
  return [...doc.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
}

function readMermaid(): string {
  const [first] = readMermaidBlocks();
  if (!first) throw new Error('no mermaid block in system-diagram.md');
  return first;
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

/**
 * `044` task 15.5 (SEC01, design D19): the diagram also shows the two public
 * password-reset routes, the end user's mail client, the break-glass CLI run by
 * the operator, the `auth.verification` writes and the Pwned Passwords call
 * from the confirm route; every new arrow names its protocol.
 *
 * Production symbols expected: none (the change is the Markdown document and
 * its regenerated image; the image is checked by hand).
 */
const RESET_ROUTES = [
  'POST /v1/auth/password-reset/request',
  'POST /v1/auth/password-reset/confirm',
] as const;

const isMailClient = (label: string): boolean => /mail client/i.test(label);
const isBreakGlass = (label: string): boolean =>
  /break-glass|recover[:-]admin-mfa/i.test(label) && !/job/i.test(label);
const isResetRoute = (label: string): boolean => /\/v1\/auth\/password-reset\//.test(label);

describe('system diagram, 044 password reset and account recovery (task 15.5)', () => {
  it('keeps a structurally sound Mermaid block after the 044 additions', () => {
    const lines = source.split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l.startsWith('subgraph ')).length).toBe(
      lines.filter((l) => l === 'end').length,
    );
    expect(unparsed).toEqual([]);
    for (const e of edges) expect(e.label.trim(), e.text).not.toBe('');
  });

  it.each(RESET_ROUTES)('shows the public route %s', (route) => {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(flatten(source)).toMatch(new RegExp(`${escaped}(?![\\w/{-])`));
  });

  it("draws the end user's mail client as an actor", () => {
    expect([...nodes.values()].some(isMailClient)).toBe(true);
  });

  it('draws the operator as an actor of a break-glass CLI node (recover:admin-mfa)', () => {
    expect([...nodes.values()].some(isBreakGlass)).toBe(true);
    expectProtocol(find((e) => /platform operator/i.test(e.src) && isBreakGlass(e.dst)));
  });

  it('has the end user calling the reset request and confirm routes over HTTPS/JSON', () => {
    for (const route of ['/password-reset/request', '/password-reset/confirm']) {
      const matches = find((e) => e.dst.includes(route) && !/job/i.test(e.src));
      expectProtocol(matches);
      expect(
        matches.some((e) => /HTTPS/i.test(e.label) && /JSON/i.test(e.label)),
        route,
      ).toBe(true);
    }
  });

  it('has the reset routes sending reset and notice mail to the email provider over HTTPS to the ACS email API', () => {
    const matches = find((e) => isResetRoute(e.src) && /email provider/i.test(e.dst));
    expectProtocol(matches);
    expect(
      matches.some((e) => /HTTPS/i.test(e.label) && /ACS|Communication Services/i.test(e.text)),
    ).toBe(true);
  });

  it('has the email provider delivering reset and notice mail to the mail client over SMTP', () => {
    const matches = find((e) => /email provider/i.test(e.src) && isMailClient(e.dst));
    expectProtocol(matches);
    expect(matches.some((e) => /SMTP/i.test(e.label))).toBe(true);
  });

  it('has the mail client reading the mail over IMAP', () => {
    const matches = find(
      (e) => /IMAP/i.test(e.label) && (isMailClient(e.src) || isMailClient(e.dst)),
    );
    expectProtocol(matches);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('has the auth.verification writes over SQL on TLS', () => {
    const matches = find((e) => /auth\.verification/.test(e.label));
    expectProtocol(matches);
    expect(matches.some((e) => /TLS/i.test(e.label) && /SQL|PostgreSQL/i.test(e.label))).toBe(true);
  });

  it('has the break-glass CLI reaching PostgreSQL as tayzu_auth over TLS', () => {
    const matches = find((e) => isBreakGlass(e.src) && /PostgreSQL/i.test(e.dst + e.label));
    expectProtocol(matches);
    expect(matches.some((e) => /tayzu_auth/.test(e.label) && /TLS/i.test(e.label))).toBe(true);
  });

  it('has the break-glass CLI sending its notice mail to the email provider over HTTPS', () => {
    const matches = find((e) => isBreakGlass(e.src) && /email provider/i.test(e.dst));
    expectProtocol(matches);
    expect(matches.some((e) => /HTTPS/i.test(e.label))).toBe(true);
  });

  it('has the Pwned Passwords range call drawn from the confirm route', () => {
    const matches = find(
      (e) =>
        e.src.includes('/password-reset/confirm') && /Pwned Passwords|pwnedpasswords/i.test(e.dst),
    );
    expectProtocol(matches);
    expect(matches.some((e) => /HTTPS/i.test(e.label) && /range/i.test(e.label))).toBe(true);
  });

  it('gives every arrow touching a 044 surface a protocol', () => {
    const topic = /password-reset|mail client|auth\.verification|break-glass|recover[:-]admin-mfa/i;
    const fresh = find((e) => topic.test(e.text));
    expect(fresh.length).toBeGreaterThanOrEqual(8);
    for (const e of fresh) expect(e.label, e.text).toMatch(PROTOCOL);
  });
});

/**
 * `044` task 16.2 fix cycle, Resolved decision Q36 row N1 (design D19, last
 * sentences): the diagrams per trust zone carry the same `044` nodes and arrows
 * as the full diagram, and the break-glass CLI's telemetry export (OTLP, which
 * the CLI refuses to run without, Q29 and Q31) is an arrow to the monitoring
 * backend.
 *
 * Rules this suite derives from the document (none is hard-coded):
 *
 * - The first Mermaid block is the full diagram; every following block is one
 *   trust zone, whose nodes sit in its single `subgraph zone[...]` box.
 * - The zone of a node is the innermost subgraph that declares it in the full
 *   diagram.
 * - The zone block of a full-diagram subgraph is the one block whose zone box
 *   declares nodes that the subgraph directly declares (by node id). So both
 *   `acaEnv` and its nested `apiApp` map to the "API and sidecars" block.
 * - Projection (the rule the blocks already follow for `043`, for example
 *   `operator --> backfillJob` is in both the delivery block and the
 *   identity-jobs block): an arrow of the full diagram appears, with the same
 *   ends and the same label, in the zone block of each of its ends. An arrow
 *   whose two ends share a zone block appears only in the full diagram.
 *
 * Production symbols expected: none (the change is the Markdown document).
 *
 * Why this fails right now: no zone block declares a `044` node or draws a
 * `044` arrow, and the full diagram has no arrow from the break-glass CLI to
 * the monitoring backend (assertion failures only).
 */
interface Block {
  nodes: Map<string, string>;
  edges: Edge[];
  /** Node id to the id of the innermost subgraph that declares it. */
  container: Map<string, string>;
  /** Ids of the subgraphs themselves (not nodes). */
  subgraphs: Set<string>;
}

function parseBlock(blockSource: string): Block {
  const container = new Map<string, string>();
  const subgraphs = new Set<string>();
  const stack: string[] = [];
  for (const raw of blockSource.split('\n')) {
    const line = raw.trim();
    const open = /^subgraph\s+(\w+)/.exec(line);
    if (open?.[1] !== undefined) {
      stack.push(open[1]);
      subgraphs.add(open[1]);
      continue;
    }
    if (line === 'end') {
      stack.pop();
      continue;
    }
    if (line.includes('-->') || line.includes('-.->')) continue;
    const node = /^(\w+)(?:\(\[|\[\(|\[|\()"/.exec(line);
    const parent = stack.at(-1);
    if (node?.[1] !== undefined && parent !== undefined) container.set(node[1], parent);
  }
  const parsed = parse(blockSource);
  return { nodes: parsed.nodes, edges: parsed.edges, container, subgraphs };
}

const [fullBlock, ...zoneBlocks] = readMermaidBlocks().map(parseBlock);
const full: Block = fullBlock ?? parseBlock('');

/** The nodes a zone block draws inside its zone box. */
function zoneMembers(block: Block): string[] {
  return [...block.container].filter(([, box]) => box === 'zone').map(([id]) => id);
}

/** The zone block of a full-diagram subgraph (see the rules above). */
function blockOfSubgraph(subgraph: string): Block | undefined {
  const members = [...full.container].filter(([, box]) => box === subgraph).map(([id]) => id);
  const matches = zoneBlocks.filter((b) => zoneMembers(b).some((id) => members.includes(id)));
  expect(matches.length, `zone blocks for subgraph ${subgraph}`).toBeLessThanOrEqual(1);
  return matches[0];
}

/** The zone block of a full-diagram node, or undefined when it lies in no zone. */
function blockOfNode(id: string): Block | undefined {
  const subgraph = full.container.get(id);
  return subgraph === undefined ? undefined : blockOfSubgraph(subgraph);
}

const is044Label = (label: string): boolean =>
  isResetRoute(label) || isMailClient(label) || isBreakGlass(label);

/** The four `044` nodes, found in the full diagram by their labels. */
const NODES_044: [string, (label: string) => boolean][] = [
  ['reset request route', (l) => l.includes('/v1/auth/password-reset/request')],
  ['reset confirm route', (l) => l.includes('/v1/auth/password-reset/confirm')],
  ['mail client', isMailClient],
  ['break-glass CLI', isBreakGlass],
];

function fullNodeIds(pred: (label: string) => boolean): string[] {
  return [...full.nodes]
    .filter(([id, label]) => !full.subgraphs.has(id) && pred(label))
    .map(([id]) => id);
}

const ids044 = new Set(NODES_044.flatMap(([, pred]) => fullNodeIds(pred)));
const fullEdges044 = full.edges.filter((e) => ids044.has(e.srcId) || ids044.has(e.dstId));
const arrow = (e: Edge): string => `${e.srcId} -->|${e.label}| ${e.dstId}`;

/** A zone block's own `044` nodes and arrows, by id or by label. */
function drawn044(block: Block): { nodeIds: string[]; edges: Edge[] } {
  const nodeIds = [...block.nodes]
    .filter(([id, label]) => !block.subgraphs.has(id) && (ids044.has(id) || is044Label(label)))
    .map(([id]) => id);
  const edges = block.edges.filter((e) => nodeIds.includes(e.srcId) || nodeIds.includes(e.dstId));
  return { nodeIds, edges };
}

describe('system diagram, 044 trust zones and the break-glass telemetry (task 16.2, Q36 N1)', () => {
  it('has the break-glass CLI exporting its telemetry over OTLP to the monitoring backend', () => {
    const matches = full.edges.filter(
      (e) => isBreakGlass(e.src) && /Azure Monitor|Application Insights|monitoring/i.test(e.dst),
    );
    expect(matches.map(arrow)).not.toEqual([]);
    expect(matches.some((e) => /OTLP/.test(e.label))).toBe(true);
  });

  it.each(NODES_044)('every 044 node appears in the block of its zone: %s', (_name, pred) => {
    const found = fullNodeIds(pred);
    expect(found).toHaveLength(1);
    const id = found[0] ?? '';
    const subgraph = full.container.get(id);
    expect(subgraph, `${id} is declared in a subgraph of the full diagram`).toBeDefined();
    const block = blockOfSubgraph(subgraph ?? '');
    expect(block, `a zone block for subgraph ${String(subgraph)}`).toBeDefined();
    expect(
      zoneMembers(block ?? full),
      `${id} inside the zone box of ${String(subgraph)}`,
    ).toContain(id);
    expect(block?.nodes.get(id)).toBe(full.nodes.get(id));
  });

  it('every arrow of the full diagram that touches a 044 node appears with the same label in the zone block of each of its ends that lies in a zone', () => {
    expect(ids044.size).toBe(NODES_044.length);
    expect(fullEdges044.length).toBeGreaterThanOrEqual(12);
    const missing: string[] = [];
    for (const e of fullEdges044) {
      const srcBlock = blockOfNode(e.srcId);
      const dstBlock = blockOfNode(e.dstId);
      // An arrow inside one zone appears only in the full diagram.
      if (srcBlock !== undefined && srcBlock === dstBlock) continue;
      for (const block of [srcBlock, dstBlock]) {
        if (block === undefined) continue;
        const drawn = block.edges.some(
          (z) =>
            z.srcId === e.srcId &&
            z.dstId === e.dstId &&
            z.label === e.label &&
            // Both ends are declared in the block, with the full diagram's labels.
            block.nodes.get(e.srcId) === e.src &&
            block.nodes.get(e.dstId) === e.dst,
        );
        if (!drawn) missing.push(`[${block.nodes.get('zone') ?? '?'}] ${arrow(e)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('no zone block draws a 044 node or a 044 arrow that the full diagram does not have', () => {
    const extra: string[] = [];
    let drawn = 0;
    for (const block of zoneBlocks) {
      const zone = block.nodes.get('zone') ?? '?';
      const { nodeIds, edges: zoneEdges } = drawn044(block);
      drawn += nodeIds.length + zoneEdges.length;
      for (const id of nodeIds) {
        if (!ids044.has(id) || block.nodes.get(id) !== full.nodes.get(id)) {
          extra.push(`[${zone}] node ${id}: ${block.nodes.get(id) ?? ''}`);
        }
      }
      for (const z of zoneEdges) {
        const inFull = fullEdges044.some(
          (e) => e.srcId === z.srcId && e.dstId === z.dstId && e.label === z.label,
        );
        if (!inFull) extra.push(`[${zone}] ${arrow(z)}`);
      }
    }
    expect(extra).toEqual([]);
    // Not vacuous: the zone blocks do draw 044 nodes and arrows.
    expect(drawn).toBeGreaterThan(0);
  });

  it('every arrow of a zone block that touches a 044 node names a protocol', () => {
    const touching = zoneBlocks.flatMap((block) => drawn044(block).edges);
    expect(touching.length).toBeGreaterThan(0);
    for (const e of touching) expect(e.label, e.text).toMatch(PROTOCOL);
  });
});

/**
 * `045` task 10.5 (SEC01, design D2, D3 and the SEC01 row of the security
 * walk-through): the diagram shows the org-deletion purge job with its one
 * database connection as `tayzu_purge`, the reversal job
 * (`tayzu-cancel-org-deletion`) with its one database connection as
 * `tayzu_deletion_admin`, the GitHub Actions maintenance workflow
 * (`identity-maintenance`) that starts the reversal through OIDC on Azure
 * Resource Manager, and the platform operator's reversal as a
 * `workflow_dispatch` of that workflow. Every new arrow names its protocol, in
 * the full diagram and in the zone block of each trust zone it touches, under
 * the projection rules of the `044` zone suite above.
 *
 * Node ids the suite requires in the full diagram: `purgeJob`, `reversalJob`
 * and `maintenanceWorkflow`. The operator and PostgreSQL are found by label.
 * The workflow sits in the `delivery` subgraph (GitHub Actions, outside the
 * product boundary, beside CI and the operator); the two jobs sit in a zone
 * that has a zone block and is neither the workflow's nor PostgreSQL's, so each
 * of their arrows crosses a zone boundary and is drawn in both zone blocks.
 *
 * Production symbols expected: none (the change is the Markdown document).
 *
 * Why this fails right now: the diagram has none of the three nodes and none
 * of their arrows (assertion failures only).
 */
const PURGE_JOB = 'purgeJob';
const REVERSAL_JOB = 'reversalJob';
const MAINTENANCE_WORKFLOW = 'maintenanceWorkflow';

/** The three `045` nodes, by the id this suite requires and a label check. */
const NODES_045: [string, string, (label: string) => boolean][] = [
  [
    'purge job (scheduled Container Apps Job)',
    PURGE_JOB,
    (l) => /purge/i.test(l) && /Container Apps Job/i.test(l) && /schedul/i.test(l),
  ],
  [
    'reversal job (tayzu-cancel-org-deletion)',
    REVERSAL_JOB,
    (l) => l.includes('tayzu-cancel-org-deletion') && /Container Apps Job/i.test(l),
  ],
  [
    'maintenance workflow (identity-maintenance)',
    MAINTENANCE_WORKFLOW,
    (l) => l.includes('identity-maintenance') && /GitHub Actions/i.test(l),
  ],
];

const ids045 = new Set(NODES_045.map(([, id]) => id));
const is045Label = (label: string): boolean => NODES_045.some(([, , pred]) => pred(label));
const fullEdges045 = full.edges.filter((e) => ids045.has(e.srcId) || ids045.has(e.dstId));

/** The one node of the full diagram whose label matches, or a failed expectation. */
function onlyFullNode(name: string, pred: (label: string) => boolean): string {
  const found = fullNodeIds(pred);
  expect(found, name).toHaveLength(1);
  return found[0] ?? '';
}

const operatorId = (): string =>
  onlyFullNode('the platform operator actor', (l) => /platform operator/i.test(l));
const postgresId = (): string => onlyFullNode('PostgreSQL', (l) => /^PostgreSQL 18\b/.test(l));

/** Every arrow of a job that is a database connection (to PostgreSQL, or naming a role). */
function databaseConnections(jobId: string): Edge[] {
  const pg = postgresId();
  return full.edges.filter(
    (e) => e.srcId === jobId && (e.dstId === pg || /PostgreSQL|tayzu_\w+/.test(e.label)),
  );
}

/** A zone block's own `045` nodes and arrows, by id or by label. */
function drawn045(block: Block): { nodeIds: string[]; edges: Edge[] } {
  const nodeIds = [...block.nodes]
    .filter(([id, label]) => !block.subgraphs.has(id) && (ids045.has(id) || is045Label(label)))
    .map(([id]) => id);
  const edges = block.edges.filter((e) => nodeIds.includes(e.srcId) || nodeIds.includes(e.dstId));
  return { nodeIds, edges };
}

describe('system diagram, 045 org deletion purge, reversal and maintenance workflow (task 10.5)', () => {
  it.each(NODES_045)('draws the %s as node %s of the full diagram', (name, id, pred) => {
    expect(full.subgraphs.has(id), `${id} is a node, not a subgraph`).toBe(false);
    expect(full.nodes.get(id), `${id} is declared in the full diagram`).toBeDefined();
    expect(pred(full.nodes.get(id) ?? ''), `${id} label: ${full.nodes.get(id) ?? ''}`).toBe(true);
    // The label check names one node only.
    expect(fullNodeIds(pred), name).toEqual([id]);
  });

  it('has the purge job with its one database connection, PostgreSQL over TLS as tayzu_purge', () => {
    const out = databaseConnections(PURGE_JOB);
    expect(out.map(arrow)).toHaveLength(1);
    const [edge] = out;
    expect(edge?.dstId).toBe(postgresId());
    expectProtocol(out);
    expect(edge?.label).toMatch(/PostgreSQL/);
    expect(edge?.label).toMatch(/TLS/);
    expect(edge?.label).toContain('tayzu_purge');
    // The purge job holds no role of another job or of the runtime (D2, Q49).
    expect(edge?.label).not.toMatch(/tayzu_(?:auth|app|migrator|deletion_admin)\b/);
  });

  it('has the reversal job with its one database connection, PostgreSQL over TLS as tayzu_deletion_admin', () => {
    const out = databaseConnections(REVERSAL_JOB);
    expect(out.map(arrow)).toHaveLength(1);
    const [edge] = out;
    expect(edge?.dstId).toBe(postgresId());
    expectProtocol(out);
    expect(edge?.label).toMatch(/PostgreSQL/);
    expect(edge?.label).toMatch(/TLS/);
    expect(edge?.label).toContain('tayzu_deletion_admin');
    expect(edge?.label).not.toMatch(/tayzu_(?:auth|app|migrator|purge)\b/);
  });

  it('has the maintenance workflow starting the reversal Container Apps Job through OIDC on Azure Resource Manager over HTTPS', () => {
    const matches = full.edges.filter(
      (e) =>
        e.srcId === MAINTENANCE_WORKFLOW &&
        /Container Apps/i.test(e.dst) &&
        (e.label + ' ' + e.dst).includes('tayzu-cancel-org-deletion'),
    );
    expect(matches.map(arrow)).not.toEqual([]);
    expectProtocol(matches);
    expect(
      matches.some(
        (e) =>
          /HTTPS/.test(e.label) &&
          /OIDC/.test(e.label) &&
          /Azure Resource Manager|\bARM\b/.test(e.label),
      ),
      matches.map(arrow).join('\n'),
    ).toBe(true);
  });

  it("has the platform operator's reversal as a workflow_dispatch of the maintenance workflow on GitHub over HTTPS", () => {
    const operator = operatorId();
    const matches = full.edges.filter(
      (e) => e.srcId === operator && e.dstId === MAINTENANCE_WORKFLOW,
    );
    expectProtocol(matches);
    expect(
      matches.some(
        (e) => /workflow_dispatch/.test(e.label) && /GitHub/.test(e.label) && /HTTPS/.test(e.label),
      ),
      matches.map(arrow).join('\n'),
    ).toBe(true);
  });

  it('starts the reversal job only through the maintenance workflow (D3)', () => {
    const into = full.edges.filter((e) => e.dstId === REVERSAL_JOB);
    expect(into.length).toBeGreaterThan(0);
    for (const e of into) expect(e.srcId, arrow(e)).toBe(MAINTENANCE_WORKFLOW);
  });

  it('gives every arrow of the full diagram that touches a 045 node a protocol', () => {
    // At least the four arrows the cases above require.
    expect(fullEdges045.length).toBeGreaterThanOrEqual(4);
    for (const e of fullEdges045) expect(e.label, e.text).toMatch(PROTOCOL);
  });

  it.each(NODES_045)('the %s (%s) appears in the zone box of its zone block', (_name, id) => {
    const subgraph = full.container.get(id);
    expect(subgraph, `${id} is declared in a subgraph of the full diagram`).toBeDefined();
    const block = blockOfSubgraph(subgraph ?? '');
    expect(block, `a zone block for subgraph ${String(subgraph)}`).toBeDefined();
    expect(
      zoneMembers(block ?? full),
      `${id} inside the zone box of ${String(subgraph)}`,
    ).toContain(id);
    expect(block?.nodes.get(id)).toBe(full.nodes.get(id));
  });

  it('puts the maintenance workflow in the delivery zone, and each job in a zone that is neither the workflow nor PostgreSQL zone', () => {
    expect(full.container.get(MAINTENANCE_WORKFLOW)).toBe('delivery');
    const workflowBlock = blockOfNode(MAINTENANCE_WORKFLOW);
    const pgBlock = blockOfNode(postgresId());
    for (const job of [PURGE_JOB, REVERSAL_JOB]) {
      const jobBlock = blockOfNode(job);
      expect(jobBlock, `${job} lies in a zone with a zone block`).toBeDefined();
      expect(jobBlock === workflowBlock, `${job} shares the workflow's zone`).toBe(false);
      expect(jobBlock === pgBlock, `${job} shares PostgreSQL's zone`).toBe(false);
    }
  });

  it('every arrow of the full diagram that touches a 045 node appears with the same label in the zone block of each of its ends that lies in a zone', () => {
    expect(fullEdges045.length).toBeGreaterThanOrEqual(4);
    const missing: string[] = [];
    let required = 0;
    for (const e of fullEdges045) {
      const srcBlock = blockOfNode(e.srcId);
      const dstBlock = blockOfNode(e.dstId);
      // An arrow inside one zone appears only in the full diagram.
      if (srcBlock !== undefined && srcBlock === dstBlock) continue;
      for (const block of [srcBlock, dstBlock]) {
        if (block === undefined) continue;
        required += 1;
        const drawn = block.edges.some(
          (z) =>
            z.srcId === e.srcId &&
            z.dstId === e.dstId &&
            z.label === e.label &&
            // Both ends are declared in the block, with the full diagram's labels.
            block.nodes.get(e.srcId) === e.src &&
            block.nodes.get(e.dstId) === e.dst,
        );
        if (!drawn) missing.push(`[${block.nodes.get('zone') ?? '?'}] ${arrow(e)}`);
      }
    }
    expect(missing).toEqual([]);
    // Not vacuous: the two database connections and the workflow's start of the
    // reversal cross zones, so each is drawn in two zone blocks.
    expect(required).toBeGreaterThanOrEqual(6);
  });

  it('no zone block draws a 045 node or a 045 arrow that the full diagram does not have', () => {
    const extra: string[] = [];
    let drawn = 0;
    for (const block of zoneBlocks) {
      const zone = block.nodes.get('zone') ?? '?';
      const { nodeIds, edges: zoneEdges } = drawn045(block);
      drawn += nodeIds.length + zoneEdges.length;
      for (const id of nodeIds) {
        if (!ids045.has(id) || block.nodes.get(id) !== full.nodes.get(id)) {
          extra.push(`[${zone}] node ${id}: ${block.nodes.get(id) ?? ''}`);
        }
      }
      for (const z of zoneEdges) {
        const inFull = fullEdges045.some(
          (e) => e.srcId === z.srcId && e.dstId === z.dstId && e.label === z.label,
        );
        if (!inFull) extra.push(`[${zone}] ${arrow(z)}`);
      }
    }
    expect(extra).toEqual([]);
    // Not vacuous: the zone blocks do draw 045 nodes and arrows.
    expect(drawn).toBeGreaterThan(0);
  });

  it('every arrow of a zone block that touches a 045 node names a protocol', () => {
    const touching = zoneBlocks.flatMap((block) => drawn045(block).edges);
    expect(touching.length).toBeGreaterThan(0);
    for (const e of touching) expect(e.label, e.text).toMatch(PROTOCOL);
  });
});

/**
 * `003` task 11.6 (SEC01, design D9, D11, D16 and D17; Resolved decisions Q2,
 * Q14, Q28 and Q56): the diagram shows the browser running the web app SPA, the
 * asset and page routes the API container serves it from (`WEB_DIST_DIR`), the
 * SPA's HTTPS calls to `/v1` and `/api/auth` on the same origin, and the Visma
 * Connect sign-in and step-up redirects, in the full diagram and in the zone
 * block of each trust zone it touches, under the projection rules of the `044`
 * zone suite above. Every new arrow names its protocol and is drawn solid
 * (`-->`), because the code exists in the repository.
 *
 * ## Contract the diagram must meet
 *
 * Nodes (declared once in the full diagram, and inside the zone box of their
 * zone block with the same label):
 *
 * - `browserSpa`, in the `productActors` subgraph: the browser running the web
 *   app SPA. Its label names "browser", "SPA" and "(003)", for example
 *   `browserSpa(["Browser running the web app SPA (003)<br/>apps/web, loaded from the apps/api origin"])`.
 * - `webRoutesApi`, in the `apiApp` subgraph (the API container serves the
 *   build): the asset and page routes. Its label names "(003)", `WEB_DIST_DIR`,
 *   `/assets/*`, `index.html` and the app pages, for example
 *   `webRoutesApi["Web app routes (003)<br/>mounted only when WEB_DIST_DIR is set<br/>GET /assets/* (hashed, immutable) · root build files<br/>SPA fallback: index.html for / and every app page"]`.
 *
 * Arrows (solid, each from `browserSpa`, each label naming HTTPS):
 *
 * 1. to `webRoutesApi`: same origin, the root `/`, `/assets/*` and the app
 *    pages, for example `"HTTPS GET (same origin): /, /assets/* and the app pages"`;
 * 2. to `catalogApi`: same origin, `/v1`, for example
 *    `"HTTPS (same origin, session cookie, CSRF header): /v1"`;
 * 3. to `authApi`: same origin, `/api/auth`, for example
 *    `"HTTPS (same origin, session cookie): /api/auth"`;
 * 4. to `visma`: the sign-in redirect, naming "redirect" and "sign-in" and not
 *    the step-up, for example `"HTTPS (browser redirect to the Visma Connect sign-in)"`;
 * 5. to `ssoApi`: the `form_post` callback to `/api/auth/callback`, for example
 *    `"HTTPS POST (form_post callback from Visma Connect): /api/auth/callback/visma-connect"`;
 * 6. to `visma`: the step-up redirect, naming "redirect" and "step-up", for
 *    example `"HTTPS (browser redirect to the Visma Connect step-up re-authorization)"`;
 * 7. to `reauthApi`: the step-up callback answered `303` to `/step-up/complete`,
 *    for example `"HTTPS (step-up callback, query or form_post): 303 See Other to /step-up/complete"`.
 *
 * Zones: every arrow crosses a zone boundary, so arrows 1, 2, 3, 5 and 7 are
 * drawn in the Product actors block and in the API and sidecars block, and
 * arrows 4 and 6 in the Product actors block and in the Supporting systems
 * block, with the full diagram's labels (14 projections).
 *
 * Production symbols expected: none (the change is the Markdown document and
 * its regenerated images; the render is checked with
 * `npx -y @mermaid-js/mermaid-cli`).
 *
 * Why this fails right now: the diagram has neither node and none of the seven
 * arrows (assertion failures only).
 */
const BROWSER_SPA = 'browserSpa';
const WEB_ROUTES = 'webRoutesApi';

const HTTPS = /\bHTTPS\b/;
const SAME_ORIGIN = /same origin/i;
const STEP_UP = /step-up|re-?authori[sz]/i;
/** The root path `/` as a token of its own (not the start of `/assets` or `/v1`). */
const ROOT_PATH = /(?:^|[\s(:,])\/(?=[\s,;)]|$)/;

/** The two `003` nodes: name, required id, required subgraph, label check. */
const NODES_003: [string, string, string, (label: string) => boolean][] = [
  [
    'browser running the web app SPA',
    BROWSER_SPA,
    'productActors',
    (l) => /browser/i.test(l) && /\bSPA\b/.test(l) && l.includes('(003)'),
  ],
  [
    'asset and page routes served from WEB_DIST_DIR',
    WEB_ROUTES,
    'apiApp',
    (l) =>
      l.includes('(003)') &&
      l.includes('WEB_DIST_DIR') &&
      l.includes('/assets/*') &&
      l.includes('index.html') &&
      /app pages?/i.test(l),
  ],
];

/** The seven `003` arrows from the browser SPA: name, target id, target subgraph, label check. */
const ARROWS_003: [string, string, string, (label: string) => boolean][] = [
  [
    'loads /, /assets/* and the app pages from the asset and page routes over HTTPS on the same origin',
    WEB_ROUTES,
    'apiApp',
    (l) =>
      HTTPS.test(l) &&
      SAME_ORIGIN.test(l) &&
      ROOT_PATH.test(l) &&
      l.includes('/assets/*') &&
      /app pages?/i.test(l),
  ],
  [
    'calls /v1 over HTTPS on the same origin',
    'catalogApi',
    'apiApp',
    (l) => HTTPS.test(l) && SAME_ORIGIN.test(l) && /\/v1\b/.test(l),
  ],
  [
    'calls /api/auth over HTTPS on the same origin',
    'authApi',
    'apiApp',
    (l) => HTTPS.test(l) && SAME_ORIGIN.test(l) && l.includes('/api/auth'),
  ],
  [
    'is redirected to the Visma Connect sign-in over HTTPS',
    'visma',
    'external',
    (l) => HTTPS.test(l) && /redirect/i.test(l) && /sign-in|sign in/i.test(l) && !STEP_UP.test(l),
  ],
  [
    'brings the form_post sign-in callback back to /api/auth/callback over HTTPS',
    'ssoApi',
    'apiApp',
    (l) => HTTPS.test(l) && l.includes('form_post') && l.includes('/api/auth/callback'),
  ],
  [
    'is redirected to the Visma Connect step-up re-authorization over HTTPS',
    'visma',
    'external',
    (l) => HTTPS.test(l) && /redirect/i.test(l) && STEP_UP.test(l),
  ],
  [
    'returns from the step-up callback with a 303 to /step-up/complete over HTTPS',
    'reauthApi',
    'apiApp',
    (l) => HTTPS.test(l) && /\b303\b/.test(l) && l.includes('/step-up/complete'),
  ],
];

const ids003 = new Set(NODES_003.map(([, id]) => id));
const is003Label = (label: string): boolean => NODES_003.some(([, , , pred]) => pred(label));
const fullEdges003 = full.edges.filter((e) => ids003.has(e.srcId) || ids003.has(e.dstId));

/** The arrows of the full diagram from the browser SPA to `dst` whose label passes `pred`. */
function browserArrows(dst: string, pred: (label: string) => boolean): Edge[] {
  return full.edges.filter((e) => e.srcId === BROWSER_SPA && e.dstId === dst && pred(e.label));
}

/** A zone block's own `003` nodes and arrows, by id or by label. */
function drawn003(block: Block): { nodeIds: string[]; edges: Edge[] } {
  const nodeIds = [...block.nodes]
    .filter(([id, label]) => !block.subgraphs.has(id) && (ids003.has(id) || is003Label(label)))
    .map(([id]) => id);
  const edges = block.edges.filter((e) => nodeIds.includes(e.srcId) || nodeIds.includes(e.dstId));
  return { nodeIds, edges };
}

describe('system diagram, 003 web app SPA, its same-origin routes and the Visma Connect redirects (task 11.6)', () => {
  it('keeps every Mermaid block structurally sound after the 003 additions', () => {
    for (const blockSource of readMermaidBlocks()) {
      const lines = blockSource.split('\n').map((l) => l.trim());
      expect(lines.filter((l) => l.startsWith('subgraph ')).length).toBe(
        lines.filter((l) => l === 'end').length,
      );
      const parsed = parse(blockSource);
      expect(parsed.unparsed).toEqual([]);
      for (const e of parsed.edges) expect(e.label.trim(), e.text).not.toBe('');
    }
  });

  it.each(NODES_003)(
    'draws the %s as node %s of the full diagram, in subgraph %s',
    (name, id, subgraph, pred) => {
      expect(full.subgraphs.has(id), `${id} is a node, not a subgraph`).toBe(false);
      expect(full.nodes.get(id), `${id} is declared in the full diagram`).toBeDefined();
      expect(pred(full.nodes.get(id) ?? ''), `${id} label: ${full.nodes.get(id) ?? ''}`).toBe(true);
      // The label check names one node only.
      expect(fullNodeIds(pred), name).toEqual([id]);
      expect(full.container.get(id), `${id} sits in subgraph ${subgraph}`).toBe(subgraph);
    },
  );

  it.each(ARROWS_003)('has the browser SPA arrow that %s (to %s)', (_name, dst, subgraph, pred) => {
    expect(full.nodes.get(dst), `${dst} is declared in the full diagram`).toBeDefined();
    expect(full.container.get(dst), `${dst} sits in subgraph ${subgraph}`).toBe(subgraph);
    const matches = browserArrows(dst, pred);
    const present = full.edges.filter((e) => e.srcId === BROWSER_SPA && e.dstId === dst).map(arrow);
    expect(matches.length, `arrows ${BROWSER_SPA} --> ${dst}:\n${present.join('\n')}`).toBe(1);
    expectProtocol(matches);
  });

  it('draws the sign-in and the step-up redirects to Visma Connect as two different arrows', () => {
    const [, , , signIn] = ARROWS_003[3] ?? [];
    const [, , , stepUp] = ARROWS_003[5] ?? [];
    const signInArrows = browserArrows('visma', signIn ?? (() => false));
    const stepUpArrows = browserArrows('visma', stepUp ?? (() => false));
    expect(signInArrows).toHaveLength(1);
    expect(stepUpArrows).toHaveLength(1);
    expect(signInArrows[0]?.label).not.toBe(stepUpArrows[0]?.label);
  });

  it('draws every 003 arrow solid, in every block, because the code exists', () => {
    const touches = new RegExp(`(?:^|\\s)(?:${[...ids003].join('|')})(?:\\s|$)`);
    const dashed: string[] = [];
    for (const blockSource of readMermaidBlocks()) {
      for (const line of blockSource.split('\n')) {
        const ends = line.replace(/\|"[^"]*"\|/, ' ');
        if (line.includes('-.->') && touches.test(ends)) dashed.push(line.trim());
      }
    }
    expect(dashed).toEqual([]);
  });

  it('gives every arrow of the full diagram that touches a 003 node a protocol', () => {
    // At least the seven arrows the cases above require.
    expect(fullEdges003.length).toBeGreaterThanOrEqual(ARROWS_003.length);
    for (const e of fullEdges003) expect(e.label, e.text).toMatch(PROTOCOL);
  });

  it.each(NODES_003)('the %s (%s) appears in the zone box of its zone block', (_name, id) => {
    const subgraph = full.container.get(id);
    expect(subgraph, `${id} is declared in a subgraph of the full diagram`).toBeDefined();
    const block = blockOfSubgraph(subgraph ?? '');
    expect(block, `a zone block for subgraph ${String(subgraph)}`).toBeDefined();
    expect(
      zoneMembers(block ?? full),
      `${id} inside the zone box of ${String(subgraph)}`,
    ).toContain(id);
    expect(block?.nodes.get(id)).toBe(full.nodes.get(id));
  });

  it.each(ARROWS_003)(
    'the browser SPA arrow that %s (to %s) appears with the same label in the Product actors block and in the block of subgraph %s',
    (_name, dst, subgraph, pred) => {
      const [e] = browserArrows(dst, pred);
      expect(e, `the full diagram has the arrow ${BROWSER_SPA} --> ${dst}`).toBeDefined();
      if (e === undefined) return;
      const srcBlock = blockOfNode(BROWSER_SPA);
      const dstBlock = blockOfNode(dst);
      expect(srcBlock, `${BROWSER_SPA} lies in a zone with a zone block`).toBeDefined();
      expect(srcBlock).toBe(blockOfSubgraph('productActors'));
      expect(dstBlock, `${dst} lies in a zone with a zone block`).toBeDefined();
      expect(dstBlock).toBe(blockOfSubgraph(subgraph));
      // The arrow crosses a zone boundary, so both blocks draw it.
      expect(srcBlock === dstBlock, `${BROWSER_SPA} and ${dst} share a zone`).toBe(false);
      const missing: string[] = [];
      for (const block of [srcBlock, dstBlock]) {
        if (block === undefined) continue;
        const drawn = block.edges.some(
          (z) =>
            z.srcId === e.srcId &&
            z.dstId === e.dstId &&
            z.label === e.label &&
            // Both ends are declared in the block, with the full diagram's labels.
            block.nodes.get(e.srcId) === e.src &&
            block.nodes.get(e.dstId) === e.dst,
        );
        if (!drawn) missing.push(`[${block.nodes.get('zone') ?? '?'}] ${arrow(e)}`);
      }
      expect(missing).toEqual([]);
    },
  );

  it('every arrow of the full diagram that touches a 003 node appears with the same label in the zone block of each of its ends that lies in a zone', () => {
    expect(fullEdges003.length).toBeGreaterThanOrEqual(ARROWS_003.length);
    const missing: string[] = [];
    let required = 0;
    for (const e of fullEdges003) {
      const srcBlock = blockOfNode(e.srcId);
      const dstBlock = blockOfNode(e.dstId);
      // An arrow inside one zone appears only in the full diagram.
      if (srcBlock !== undefined && srcBlock === dstBlock) continue;
      for (const block of [srcBlock, dstBlock]) {
        if (block === undefined) continue;
        required += 1;
        const drawn = block.edges.some(
          (z) =>
            z.srcId === e.srcId &&
            z.dstId === e.dstId &&
            z.label === e.label &&
            block.nodes.get(e.srcId) === e.src &&
            block.nodes.get(e.dstId) === e.dst,
        );
        if (!drawn) missing.push(`[${block.nodes.get('zone') ?? '?'}] ${arrow(e)}`);
      }
    }
    expect(missing).toEqual([]);
    // Not vacuous: each of the seven arrows crosses a zone, so it is drawn twice.
    expect(required).toBeGreaterThanOrEqual(2 * ARROWS_003.length);
  });

  it('no zone block draws a 003 node or a 003 arrow that the full diagram does not have', () => {
    const extra: string[] = [];
    let drawn = 0;
    for (const block of zoneBlocks) {
      const zone = block.nodes.get('zone') ?? '?';
      const { nodeIds, edges: zoneEdges } = drawn003(block);
      drawn += nodeIds.length + zoneEdges.length;
      for (const id of nodeIds) {
        if (!ids003.has(id) || block.nodes.get(id) !== full.nodes.get(id)) {
          extra.push(`[${zone}] node ${id}: ${block.nodes.get(id) ?? ''}`);
        }
      }
      for (const z of zoneEdges) {
        const inFull = fullEdges003.some(
          (e) => e.srcId === z.srcId && e.dstId === z.dstId && e.label === z.label,
        );
        if (!inFull) extra.push(`[${zone}] ${arrow(z)}`);
      }
    }
    expect(extra).toEqual([]);
    // Not vacuous: the zone blocks do draw 003 nodes and arrows.
    expect(drawn).toBeGreaterThan(0);
  });

  it('every arrow of a zone block that touches a 003 node names a protocol', () => {
    const touching = zoneBlocks.flatMap((block) => drawn003(block).edges);
    expect(touching.length).toBeGreaterThan(0);
    for (const e of touching) expect(e.label, e.text).toMatch(PROTOCOL);
  });
});
