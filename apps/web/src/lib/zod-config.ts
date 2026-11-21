/**
 * D10: the strict CSP (`script-src 'self'`, no `'unsafe-eval'`) reports even a caught
 * `new Function` as a `securitypolicyviolation`. Zod 4 builds its object fast path with
 * `new Function` and probes for it once (`util.allowsEval`), when the first `z.object`
 * is created. Jitless mode skips both the probe and the fast path. This module must be
 * the first import of `main.tsx`: module-level schemas (the catalog contract, the search
 * params, the auth client) read the flag when they are created, not when they parse.
 */
import { z } from 'zod';

z.config({ jitless: true });
