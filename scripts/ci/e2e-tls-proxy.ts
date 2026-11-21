/**
 * The test-only TLS reverse proxy of the e2e stack (003 task 10.1, design D16, Resolved
 * decision Q38). Outside the test harness every origin must be `https:`, so
 * `scripts/ci/e2e.sh` puts this proxy in front of the API and of the OIDC stub: each
 * `--route <port>=<upstream>` is one `node:https` listener on 127.0.0.1 that forwards
 * every request, unchanged, to a plain-HTTP upstream on 127.0.0.1. Its certificate is
 * the `localhost` one of the run's throwaway CA (`--cert` may hold the chain), so the
 * browser and Node verify it; nothing here relaxes TLS.
 *
 *   tsx scripts/ci/e2e-tls-proxy.ts --cert proxy-chain.crt --key proxy.key \
 *     --route 8443=http://127.0.0.1:3001 --route 8444=http://127.0.0.1:3002
 *
 * It never logs a request: a path or a query can carry a token or a link. It is not
 * product code and never runs outside the e2e stack.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer, type Server } from 'node:https';
import { parseArgs } from 'node:util';

const LISTEN_HOST = '127.0.0.1';

/** Hop-by-hop headers (RFC 9110 §7.6.1): never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

export interface ProxyRoute {
  /** The https port on 127.0.0.1. */
  readonly port: number;
  /** The plain-HTTP upstream origin, always on 127.0.0.1. */
  readonly upstream: URL;
}

function parsePort(raw: string): number {
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error('e2e-tls-proxy: a route port must be an integer between 1 and 65535.');
  }
  return Number(raw);
}

/** `<port>=http://127.0.0.1:<port>`: the upstream is a loopback origin, nothing else. */
export function parseRoute(raw: string): ProxyRoute {
  const separator = raw.indexOf('=');
  if (separator === -1) throw new Error('e2e-tls-proxy: a route is <port>=<upstream origin>.');
  const port = parsePort(raw.slice(0, separator));
  let upstream: URL;
  try {
    upstream = new URL(raw.slice(separator + 1));
  } catch {
    throw new Error('e2e-tls-proxy: a route upstream must be an absolute URL.');
  }
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== LISTEN_HOST ||
    upstream.port === '' ||
    upstream.pathname !== '/' ||
    upstream.search !== '' ||
    upstream.username !== ''
  ) {
    throw new Error('e2e-tls-proxy: a route upstream must be http://127.0.0.1:<port>.');
  }
  return { port, upstream };
}

/** The request headers sent upstream: hop-by-hop dropped, the forwarding headers set. */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) forwarded[name] = value;
  }
  // The client of a loopback proxy: the API trusts it only from loopback (trustProxy).
  forwarded['x-forwarded-for'] = remoteAddress ?? LISTEN_HOST;
  forwarded['x-forwarded-proto'] = 'https';
  if (headers.host !== undefined) forwarded['x-forwarded-host'] = headers.host;
  return forwarded;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) kept[name] = value;
  }
  return kept;
}

export function startProxy(
  route: ProxyRoute,
  tls: { readonly key: Buffer; readonly cert: Buffer },
): Promise<Server> {
  const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const upstream = httpRequest(
      {
        host: route.upstream.hostname,
        port: route.upstream.port,
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: upstreamHeaders(req.headers, req.socket.remoteAddress),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      // A fixed answer: the upstream error names the address, never the request.
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('e2e-tls-proxy: the upstream is not reachable.\n');
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(route.port, LISTEN_HOST, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cert: { type: 'string' },
      key: { type: 'string' },
      route: { type: 'string', multiple: true },
    },
    strict: true,
  });
  if (values.cert === undefined || values.key === undefined) {
    throw new Error('e2e-tls-proxy: --cert and --key are required.');
  }
  const routes = (values.route ?? []).map(parseRoute);
  if (routes.length === 0) throw new Error('e2e-tls-proxy: at least one --route is required.');
  const tls = { key: readFileSync(values.key), cert: readFileSync(values.cert) };

  const servers = await Promise.all(routes.map((route) => startProxy(route, tls)));
  process.stdout.write(
    `e2e-tls-proxy: listening on ${routes.map((route) => `https://localhost:${String(route.port)}`).join(', ')}\n`,
  );

  const stop = (): void => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'e2e-tls-proxy failed'}\n`);
  process.exitCode = 1;
});
