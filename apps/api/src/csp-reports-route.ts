/**
 * `POST /v1/csp-reports` (048 design D9, Q10, Q26): the same-origin endpoint of the CSP
 * `report-uri` and `report-to` directives. Browsers send reports unauthenticated, so the
 * route is public and spoofable: it never reads a cookie, a session or any header but the
 * media type, counts each report by its mapped directive only, writes no log record, and
 * always answers `204` with no body, whether the report is well formed, malformed, hostile
 * or larger than its 8 KiB limit.
 */
import { recordIdentityMetric } from '@tayzu/auth';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { parseCspReport } from './csp-report.js';

export const CSP_REPORTS_PATH = '/v1/csp-reports';

/** D9: the two report media types; any parameter (`; charset=utf-8`) is allowed. */
export const CSP_REPORT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/csp-report',
  'application/reports+json',
]);

/** D9: the scope's `bodyLimit`, checked before any parsing. */
const CSP_REPORT_BODY_LIMIT = 8192;

const CSP_VIOLATIONS_METRIC = 'tayzu.web.csp_violations';
const CSP_DIRECTIVE = 'tayzu.web.csp.directive';

/** The bare, lower-cased media type of a request, without its parameters. */
export function mediaTypeOf(request: FastifyRequest): string {
  return (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * Registers the route in its own encapsulated scope, so its string parser and its error
 * handler change nothing for any other route.
 */
export async function registerCspReportsRoute(app: FastifyInstance): Promise<void> {
  await app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      [...CSP_REPORT_MEDIA_TYPES],
      { parseAs: 'string', bodyLimit: CSP_REPORT_BODY_LIMIT },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    // D9: the body-limit and parse errors, and any other error of the route, answer the
    // same empty `204`; nothing is counted and nothing is logged.
    scope.setErrorHandler(async (_error, _request, reply) => reply.status(204).send());
    scope.post(CSP_REPORTS_PATH, async (request, reply) => {
      try {
        const body: unknown = request.body;
        if (typeof body === 'string') {
          for (const directive of parseCspReport(mediaTypeOf(request), body)) {
            recordIdentityMetric(CSP_VIOLATIONS_METRIC, 1, { [CSP_DIRECTIVE]: directive });
          }
        }
      } catch {
        // Swallowed on purpose: a report never changes the answer and is never logged.
      }
      return reply.status(204).send();
    });
    done();
  });
}
