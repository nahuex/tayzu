/**
 * The `email` option of `createApp` for integration tests that mount the identity routes
 * (044 design D9 "Startup failure rules", Resolved decision Q36 row N4): with the mount switch
 * on, `createApp` refuses to start without the email path, the test harness included.
 *
 * The defaults are a recording sender, roomy caps (the global reset and notice buckets are
 * platform-wide, shared by every test file of a run), a non-empty reset link base URL and a
 * one-millisecond minimum reset answer so the reset request route does not slow tests. A test
 * that observes the sender, a cap or a link passes its own value in `overrides`.
 */
import { createRecordingEmailSender } from '@tayzu/auth';

import type { CreateAppOptions } from '../server.js';

export type TestEmailOptions = NonNullable<CreateAppOptions['email']>;

const TEST_LINK_BASE_URL = 'https://app.tayzu.test';

export function testEmailOptions(overrides: Partial<TestEmailOptions> = {}): TestEmailOptions {
  return {
    sender: createRecordingEmailSender(),
    invitationLinkBaseUrl: TEST_LINK_BASE_URL,
    passwordResetLinkBaseUrl: TEST_LINK_BASE_URL,
    passwordResetMinResponseMs: 1,
    disabledTenantIds: [],
    killSwitch: false,
    tenantCap: { max: 1000, windowSeconds: 3600 },
    recipientCap: { max: 1000, windowSeconds: 86_400 },
    passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
    accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    ...overrides,
  };
}
