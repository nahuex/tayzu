import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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

export default defineConfig(({ command, isPreview }) => {
  // `vite preview` inherits `server.headers` and `server.proxy` unless they
  // are scoped to the dev server.
  const isDevServer = command === 'serve' && isPreview !== true;

  return {
    plugins: [react(), tailwindcss()],
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
