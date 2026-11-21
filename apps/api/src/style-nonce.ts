/**
 * The per-response style nonce (003 design D10 "The style nonce", Q15, task 4.5).
 * Tayzu's own `onRequest` hook assigns it to the raw response before helmet runs, so the
 * `style-src` directive function (which only sees `IncomingMessage` and `ServerResponse`)
 * and the SPA fallback (through `reply.raw`) read the same value. A `WeakMap` keeps it off
 * the response object and lets it go with the response.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/** D10: 128 bits from a cryptographically secure source. */
const STYLE_NONCE_BYTES = 16;

const NONCE_MISSING = 'No style nonce was assigned to this response.';

const styleNonces = new WeakMap<ServerResponse, string>();

/** Draws a fresh nonce (standard base64) for this response and stores it. */
export function assignStyleNonce(res: ServerResponse): void {
  styleNonces.set(res, randomBytes(STYLE_NONCE_BYTES).toString('base64'));
}

/**
 * The nonce assigned to this response. Fails closed: a response the hook never saw has no
 * nonce, and the caller's error becomes the sanitized `INTERNAL` answer.
 */
export function styleNonceOf(res: ServerResponse): string {
  const nonce = styleNonces.get(res);
  if (nonce === undefined) {
    throw new Error(NONCE_MISSING);
  }
  return nonce;
}
