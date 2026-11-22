/**
 * Static serving of the web build (003 design D9, task 4.2): the hashed assets under
 * `/assets/` and the explicit list of root build files. `createApp` calls
 * `registerWebStatic` only when `webDistDir` is set; without it nothing here exists.
 *
 * Neither route ever reaches the file system with a client-supplied path. The asset
 * list is read once at startup (`wildcard: false`, one route per file), and the root
 * build files are read into memory once, by their fixed names.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Vite's asset names carry a content hash, so an asset never changes under its URL. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The root build files are unhashed, so the browser revalidates them on every use. */
export const ROOT_BUILD_FILE_CACHE_CONTROL = 'no-cache';

/** Q28: the only files served from the build root, each with its fixed content type. */
export const ROOT_BUILD_FILES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    'theme-init.js': 'text/javascript; charset=utf-8',
    'favicon.svg': 'image/svg+xml',
  }),
);

const ROOT_BUILD_FILE_UNREADABLE = 'WEB_DIST_DIR holds a root build file that is not readable.';

/**
 * Reads a root build file once; a file the build does not ship gets no route. Any other
 * failure stops startup with fixed text: the fs error is never rethrown, because its
 * message carries the path (Q21).
 */
async function readRootBuildFile(webDistDir: string, name: string): Promise<Buffer | undefined> {
  let missing: boolean;
  try {
    return await readFile(join(webDistDir, name));
  } catch (error) {
    missing = (error as { code?: unknown }).code === 'ENOENT';
  }
  if (missing) {
    return undefined;
  }
  throw new Error(ROOT_BUILD_FILE_UNREADABLE);
}

export async function registerWebStatic(app: FastifyInstance, webDistDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: join(webDistDir, 'assets'),
    prefix: '/assets/',
    wildcard: false,
    // Dotfiles are left out of the glob (`serveDotFiles` unset), so `/assets/.env` has
    // no route and is Fastify's own 404; `send` denies any that still reached it.
    dotfiles: 'deny',
    index: false,
    // `send` writes `public, max-age=<maxAge / 1000>, immutable`; a number in
    // milliseconds, because `'1y'` parses to 365.25 days.
    maxAge: 31_536_000_000,
    immutable: true,
    // No `reply.sendFile` or `reply.download`: nothing else serves a file.
    decorateReply: false,
    // A build without `assets/` registers no asset route; the warning would log the path.
    suppressWarning: true,
  });

  for (const [name, contentType] of Object.entries(ROOT_BUILD_FILES)) {
    const body = await readRootBuildFile(webDistDir, name);
    if (body === undefined) {
      continue;
    }
    app.get(`/${name}`, (_request, reply) =>
      reply
        .header('content-type', contentType)
        .header('cache-control', ROOT_BUILD_FILE_CACHE_CONTROL)
        .send(body),
    );
  }
}
