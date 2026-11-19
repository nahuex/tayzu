/**
 * Vitest setup file of `@tayzu/web (unit)` (task 2.4, design D1 and D2).
 *
 * - Registers the `@testing-library/jest-dom` matchers on Vitest's `expect`
 *   (and their types on Vitest's `Assertion`).
 * - Unmounts every rendered tree after each test. Testing Library only does
 *   this on its own when Vitest globals are enabled, and the workspace keeps
 *   them off, so the cleanup is explicit.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
