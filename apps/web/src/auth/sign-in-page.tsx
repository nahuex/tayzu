/**
 * The local sign-in page (design D11, D12, D15 and Q71).
 *
 * Email and password first (`POST /api/auth/sign-in/email`), then, when the answer asks
 * for the second factor, an authentication code (`/two-factor/verify-totp`) with a
 * switch to a backup code (`/two-factor/verify-backup-code`). Every failure is one
 * uniform message chosen from the error kind only, never from the server's text: a
 * rate limit says when to try again, a refused code says so and keeps the code step,
 * and anything else is "the email or password is incorrect". The password is emptied
 * after every request. Nothing is sent without the user's submit. Both forms live in
 * `./sign-in-forms.js`, which the accept-invitation page's embedded sign-in shares.
 *
 * "Sign in with Visma Connect" posts `/api/auth/sign-in/social` only on the user's click
 * and leaves the app only when the returned URL is an absolute `https:` URL (Q72). A
 * refused URL, any failed answer and the `?error=sso` return show one generic message;
 * neither the URL nor the server's text is ever shown.
 *
 * The credentials step links to `/forgot-password` (Q23, Q77). The link carries nothing:
 * no `returnTo` and no typed value. The code step does not show it.
 *
 * On success the cached session is removed, so the session gate reads `GET /v1/me`
 * again (it reads with `staleTime: 'static'`, which an invalidation would not move),
 * and the page goes to the route's validated `returnTo`, query included.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { AuthResult } from '../api/auth-client.js';
import { SESSION_QUERY_KEY } from '../app/session-gate.js';
import { isAbsoluteHttpsUrl } from '../lib/external-url.js';
import { navigateToExternal } from '../lib/navigate-away.js';

import { returnToOf, searchField } from './route-search.js';
import { CodeForm, CredentialsForm, type CodeStep } from './sign-in-forms.js';

/** What the page's one alert says; never anything the server wrote. */
type Notice =
  | { readonly kind: 'failed' }
  | { readonly kind: 'invalidCode' }
  | { readonly kind: 'ssoFailed' }
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds?: number };

/** A failed answer's notice: a rate limit is told apart, anything else is `fallback`. */
function noticeOf(result: AuthResult<unknown>, fallback: Notice): Notice | undefined {
  if (result.ok) return undefined;
  if (result.error.kind !== 'rate_limited') return fallback;
  return { kind: 'rateLimited', retryAfterSeconds: result.error.retryAfterSeconds };
}

/** True on the Visma Connect error return (`?error=sso`), as the route parsed it. */
function isSsoErrorReturn(search: unknown): boolean {
  return searchField(search, 'error') === 'sso';
}

function NoticeAlert({ notice }: { notice: Notice }): React.JSX.Element {
  const { t } = useTranslation('auth');
  let text: string;
  if (notice.kind !== 'rateLimited') text = t(`signIn.${notice.kind}`);
  else if (notice.retryAfterSeconds === undefined || notice.retryAfterSeconds < 1) {
    text = t('signIn.rateLimitedLater');
  } else text = t('signIn.rateLimited', { count: notice.retryAfterSeconds });
  return <Alert variant="destructive">{text}</Alert>;
}

/**
 * The Visma Connect button. It is not the credentials form's submit: a click posts the
 * social sign-in and follows the answer only when it is an absolute `https:` URL.
 */
function VismaConnectButton({ onFailed }: { onFailed: () => void }): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();

  async function signIn(): Promise<void> {
    const result = await authClient.signInWithVismaConnect();
    if (result.ok && isAbsoluteHttpsUrl(result.value.url)) navigateToExternal(result.value.url);
    else onFailed();
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        void signIn();
      }}
    >
      {t('signIn.vismaConnect')}
    </Button>
  );
}

function SignInContent(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const search: unknown = useSearch({ from: '/sign-in' });
  const returnTo = returnToOf(search);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'credentials' | CodeStep>('credentials');
  const [notice, setNotice] = useState<Notice | undefined>(() =>
    isSsoErrorReturn(search) ? { kind: 'ssoFailed' } : undefined,
  );
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);

  function signedIn(): void {
    queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
    router.history.push(returnTo);
  }

  function show(next: Notice | undefined): void {
    setNotice(next);
    setAnswers((count) => count + 1);
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('signIn.title')}</h1>
      {notice !== undefined && <NoticeAlert key={answers} notice={notice} />}
      {step === 'credentials' ? (
        <>
          <CredentialsForm
            submitLabel={t('signIn.submit')}
            onResult={(result) => {
              if (!result.ok) show(noticeOf(result, { kind: 'failed' }));
              else if (!result.value.twoFactorRequired) signedIn();
              else {
                show(undefined);
                setStep('totp');
              }
            }}
          />
          <Link to="/forgot-password" className="underline underline-offset-4">
            {t('signIn.forgotPassword')}
          </Link>
          <VismaConnectButton
            onFailed={() => {
              show({ kind: 'ssoFailed' });
            }}
          />
        </>
      ) : (
        <CodeForm
          key={step}
          step={step}
          submitLabel={t('signIn.verify')}
          onResult={(result) => {
            if (result.ok) signedIn();
            else show(noticeOf(result, { kind: 'invalidCode' }));
          }}
          onUseBackupCode={() => {
            show(undefined);
            setStep('backup');
          }}
        />
      )}
    </main>
  );
}

/** The `/sign-in` page. The `auth` namespace loads on demand, inside its own boundary. */
export function SignInPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <SignInContent />
    </Suspense>
  );
}
