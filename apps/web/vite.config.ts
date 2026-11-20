import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, minify, type Plugin } from 'vite';

/** The dev server binds loopback only and never moves to another port (design D2). */
const DEV_HOST = '127.0.0.1';
const DEV_PORT = 5173;

/** The local API the dev server proxies `/v1` and `/api/auth` to (design D10). */
const DEV_API_ORIGIN = 'http://127.0.0.1:3000';

/**
 * CSP source for the React Refresh preamble, the one inline module script
 * `@vitejs/plugin-react` injects into `index.html` in dev. Hashing it keeps
 * `'unsafe-inline'` out of the dev `script-src`.
 */
const REACT_REFRESH_PREAMBLE_HASH = `'sha256-${createHash('sha256')
  .update(react.preambleCode.replace('__BASE__', '/'))
  .digest('base64')}'`;

/**
 * The development-only policy (design D10): the production policy loosened
 * for Vite's dev server only, with `'unsafe-eval'`, inline styles and the HMR
 * WebSocket. The build never carries it.
 */
const DEV_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-eval' ${REACT_REFRESH_PREAMBLE_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  `connect-src 'self' ws://${DEV_HOST}:${String(DEV_PORT)}`,
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** The commented source of `/theme-init.js`, resolved from this file, never from `root`. */
const THEME_INIT_SOURCE = fileURLToPath(new URL('./src/state/theme-init.js', import.meta.url));

/** The unhashed root build file `index.html` loads before first paint (Q28, Q46). */
const THEME_INIT_FILE = 'theme-init.js';
const THEME_INIT_PATH = `/${THEME_INIT_FILE}`;

/**
 * Ships `src/state/theme-init.js` as the classic script `/theme-init.js` (design D12,
 * Q46). A build minifies it with Vite's own minifier, which drops every comment, and
 * emits it unhashed at the build root. The dev server serves the source as is.
 */
export function themeInitPlugin(): Plugin {
  return {
    name: 'tayzu:theme-init',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== THEME_INIT_PATH) {
          next();
          return;
        }
        readFile(THEME_INIT_SOURCE, 'utf8').then(
          (source) => {
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            response.setHeader('Cache-Control', 'no-cache');
            response.end(source);
          },
          (error: unknown) => {
            next(error);
          },
        );
      });
    },
    async generateBundle() {
      this.addWatchFile(THEME_INIT_SOURCE);
      const source = await readFile(THEME_INIT_SOURCE, 'utf8');
      const result = await minify(THEME_INIT_FILE, source, { module: false });
      if (result.errors.length > 0) {
        this.error(`${THEME_INIT_FILE} failed to minify`);
      }
      this.emitFile({ type: 'asset', fileName: THEME_INIT_FILE, source: result.code });
    },
  };
}

export default defineConfig(({ command, isPreview }) => {
  // `vite preview` inherits `server.headers` and `server.proxy` unless they
  // are scoped to the dev server.
  const isDevServer = command === 'serve' && isPreview !== true;

  return {
    plugins: [react(), tailwindcss(), themeInitPlugin()],
    // An empty directory: no `.env` file can reach `import.meta.env`.
    envDir: fileURLToPath(new URL('./env', import.meta.url)),
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: DEV_HOST,
      port: DEV_PORT,
      strictPort: true,
      fs: { strict: true },
      ...(isDevServer
        ? {
            headers: {
              'Content-Security-Policy': DEV_CONTENT_SECURITY_POLICY,
              'Referrer-Policy': 'no-referrer',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'DENY',
            },
            proxy: {
              '/v1': { target: DEV_API_ORIGIN },
              '/api/auth': { target: DEV_API_ORIGIN },
            },
          }
        : {}),
    },
  };
});
