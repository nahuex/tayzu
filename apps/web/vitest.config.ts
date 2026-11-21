import { fileURLToPath } from 'node:url';

import { defineWebPackageConfig } from '../../vitest.shared.ts';

/** The `@/` alias of `vite.config.ts`, so shadcn/ui components resolve in tests. */
export default defineWebPackageConfig('web', {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
});
