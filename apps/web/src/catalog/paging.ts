/** Cursor paging helpers shared by the catalog table and the Related tab (design D6, Q83). */
import type { ApiError } from '../api/errors.js';

/** True when a list call refused the cursor it was sent (`validation` on `/cursor`, D6). */
export function isCursorRefusal(error: ApiError | undefined): boolean {
  return error?.kind === 'validation' && error.issues.some((issue) => issue.path === '/cursor');
}
