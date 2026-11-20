/**
 * The local sign-in page (design D11, D12, D15 and Q71).
 *
 * Email and password first (`POST /api/auth/sign-in/email`), then, when the answer asks
 * for the second factor, an authentication code (`/two-factor/verify-totp`) with a
 * switch to a backup code (`/two-factor/verify-backup-code`). Every failure is one
 * uniform message chosen from the error kind only, never from the server's text: a
 * rate limit says when to try again, a refused code says so and keeps the code step,
 * and anything else is "the email or password is incorrect". The password is emptied
 * after every request. Nothing is sent without the user's submit.
 *
 * "Sign in with Visma Connect" posts `/api/auth/sign-in/social` only on the user's click
 * and leaves the app only when the returned URL is an absolute `https:` URL (Q72). A
 * refused URL, any failed answer and the `?error=sso` return show one generic message;
 * neither the URL nor the server's text is ever shown.
 *
 * On success the cached session is removed, so the session gate reads `GET /v1/me`
 * again (it reads with `staleTime: 'static'`, which an invalidation would not move),
 * and the page goes to the route's validated `returnTo`, query included.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { AuthResult } from '../api/auth-client.js';
import { SESSION_QUERY_KEY } from '../app/session-gate.js';
import { isAbsoluteHttpsUrl } from '../lib/external-url.js';
import { navigateToExternal } from '../lib/navigate-away.js';

import { Field } from './field.js';
import { returnToOf, searchField } from './route-search.js';

/** Only emptiness is checked here; the server decides everything else (Q71). */
const credentialsSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });
const codeSchema = z.object({ code: z.string().min(1) });

type Credentials = z.input<typeof credentialsSchema>;
type Code = z.input<typeof codeSchema>;

type CodeStep = 'totp' | 'backup';

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

function CredentialsForm({
  onResult,
}: {
  onResult: (result: AuthResult<{ readonly twoFactorRequired: boolean }>) => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<Credentials>({ resolver: zodResolver(credentialsSchema) });

  const submit = handleSubmit(async ({ email, password }) => {
    const result = await authClient.signInEmail({ email, password });
    setValue('password', '');
    onResult(result);
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field
        label={t('signIn.email')}
        error={errors.email === undefined ? undefined : t('signIn.emailRequired')}
        type="email"
        autoComplete="username"
        {...register('email')}
      />
      <Field
        label={t('signIn.password')}
        error={errors.password === undefined ? undefined : t('signIn.passwordRequired')}
        type="password"
        autoComplete="current-password"
        {...register('password')}
      />
      <Button type="submit">{t('signIn.submit')}</Button>
    </form>
  );
}

function CodeForm({
  step,
  onResult,
  onUseBackupCode,
}: {
  step: CodeStep;
  onResult: (result: AuthResult<void>) => void;
  onUseBackupCode: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<Code>({ resolver: zodResolver(codeSchema) });

  // The step replaced the form the user was in: keep the keyboard focus in the page.
  useEffect(() => {
    setFocus('code');
  }, [setFocus]);

  const submit = handleSubmit(async ({ code }) => {
    const result =
      step === 'totp'
        ? await authClient.verifyTotp({ code })
        : await authClient.verifyBackupCode({ code });
    setValue('code', '');
    onResult(result);
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field
        label={t(step === 'totp' ? 'signIn.code' : 'signIn.backupCode')}
        error={errors.code === undefined ? undefined : t('signIn.codeRequired')}
        type="text"
        autoComplete="one-time-code"
        {...register('code')}
      />
      <Button type="submit">{t('signIn.verify')}</Button>
      {step === 'totp' && (
        <Button type="button" variant="link" onClick={onUseBackupCode}>
          {t('signIn.useBackupCode')}
        </Button>
      )}
    </form>
  );
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
            onResult={(result) => {
              if (!result.ok) show(noticeOf(result, { kind: 'failed' }));
              else if (!result.value.twoFactorRequired) signedIn();
              else {
                show(undefined);
                setStep('totp');
              }
            }}
          />
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
