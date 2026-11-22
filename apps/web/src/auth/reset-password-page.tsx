/**
 * The password-reset page, `/reset-password` (design D11, D12, D15, D16 and Q68, Q71, Q78;
 * archived `044` D2 and D14).
 *
 * The link is `/reset-password#reset=<id>&token=<token>`. The page takes the fragment in
 * its `useState` initializer, outside its `Suspense` boundary, and removes it there with
 * `history.replaceState`, so it is gone from the address before the first commit and
 * before any request; the id and token then live only in that state. `044` D2's format
 * (22 and 43 base64url characters) is checked here, because the server answers a
 * malformed body with a non-uniform `400`: a missing or malformed fragment shows the
 * same invalid-link alert as the server's uniform `404`, with no form and no request.
 *
 * New password and confirmation, then `POST /v1/auth/password-reset/confirm` on the
 * user's submit only. On `AUTH_STEP_UP_REQUIRED` the page shows its own factor field (an
 * authentication code, or a backup code), and the user types the new password again with
 * the code; a later `AUTH_STEP_UP_REQUIRED` to a request that carried a factor is a
 * refused code. A policy failure shows the localized name of the failed rule, a rate
 * limit says when to try again, anything else is one generic alert. Both password fields
 * are emptied after every request, and no server text is ever shown.
 *
 * The page calls the auth client directly, never through the query or mutation cache, so
 * none of the id, the token, the password or the code reaches either cache. It is public:
 * it never reads the session (Q68).
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { ApiError, PasswordRule } from '../api/errors.js';

import { Field } from './field.js';

/** The reset link's values, kept in component state only. */
interface ResetLink {
  readonly id: string;
  readonly token: string;
}

/** `044` D2: 16 and 32 random bytes, base64url without padding. */
const RESET_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads the reset link from the fragment and removes the fragment from the address, in
 * the same synchronous call. `undefined` for a missing or malformed link.
 */
function takeResetLink(): ResetLink | undefined {
  const { hash, href, pathname, search } = window.location;
  if (href.includes('#')) {
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
  }
  const params = new URLSearchParams(hash.slice(1));
  const id = params.get('reset');
  const token = params.get('token');
  if (id === null || token === null) return undefined;
  if (!RESET_ID_PATTERN.test(id) || !RESET_TOKEN_PATTERN.test(token)) return undefined;
  return { id, token };
}

/** Only emptiness and the confirmation are checked here; the server decides the rest. */
const resetSchema = z.object({
  newPassword: z.string().min(1),
  confirmation: z.string().min(1),
  code: z.string(),
});

type ResetValues = z.input<typeof resetSchema>;

/** The factor the next submit carries, once the server asked for one. */
type FactorStep = 'totp' | 'backup';

/** What the page's one alert says, or the policy failure; never anything the server wrote. */
type Notice =
  | { readonly kind: 'failed' }
  | { readonly kind: 'invalidCode' }
  | { readonly kind: 'policy'; readonly rule?: PasswordRule }
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds?: number };

/** What a refused reset means for the page, but for `not_found` and `step_up_required`. */
function noticeOf(error: ApiError): Notice {
  if (error.kind === 'rate_limited') {
    return error.retryAfterSeconds === undefined
      ? { kind: 'rateLimited' }
      : { kind: 'rateLimited', retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error.kind !== 'validation') return { kind: 'failed' };
  const policy = error.issues.find((issue) => issue.path === '/newPassword');
  if (policy === undefined) return { kind: 'failed' };
  return policy.rule === undefined ? { kind: 'policy' } : { kind: 'policy', rule: policy.rule };
}

function NoticeAlert({ notice }: { notice: Notice }): React.JSX.Element | null {
  const { t } = useTranslation('auth');
  // A policy failure is shown on the new password field, not in the alert.
  if (notice.kind === 'policy') return null;
  let text: string;
  if (notice.kind !== 'rateLimited') text = t(`resetPassword.${notice.kind}`);
  else if (notice.retryAfterSeconds === undefined || notice.retryAfterSeconds < 1) {
    text = t('resetPassword.rateLimitedLater');
  } else text = t('resetPassword.rateLimited', { count: notice.retryAfterSeconds });
  return <Alert variant="destructive">{text}</Alert>;
}

function ResetForm({
  link,
  onInvalidLink,
  onCompleted,
}: {
  link: ResetLink;
  onInvalidLink: () => void;
  onCompleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const [factorStep, setFactorStep] = useState<FactorStep | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    clearErrors,
    setFocus,
    formState: { errors },
  } = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { newPassword: '', confirmation: '', code: '' },
  });

  // The factor field appeared, or changed kind: keep the keyboard focus on it.
  useEffect(() => {
    if (factorStep !== undefined) setFocus('code');
  }, [factorStep, setFocus]);

  const submit = handleSubmit(async ({ newPassword, confirmation, code }) => {
    let refused = false;
    if (confirmation !== newPassword) {
      setError('confirmation', { type: 'mismatch' });
      refused = true;
    }
    if (factorStep !== undefined && code === '') {
      setError('code', { type: 'required' });
      refused = true;
    }
    if (refused) return;
    setNotice(undefined);
    const factor =
      factorStep === undefined
        ? undefined
        : { kind: factorStep === 'totp' ? ('totp' as const) : ('backup_code' as const), code };
    const result = await authClient.confirmPasswordReset({
      id: link.id,
      token: link.token,
      newPassword,
      ...(factor === undefined ? {} : { factor }),
    });
    setValue('newPassword', '');
    setValue('confirmation', '');
    if (result.ok) {
      onCompleted();
      return;
    }
    const { error } = result;
    if (error.kind === 'not_found') {
      onInvalidLink();
      return;
    }
    if (error.kind === 'step_up_required') {
      if (factor === undefined) setFactorStep('totp');
      else {
        setValue('code', '');
        setNotice({ kind: 'invalidCode' });
        setAnswers((count) => count + 1);
      }
      return;
    }
    setNotice(noticeOf(error));
    setAnswers((count) => count + 1);
  });

  let newPasswordError: string | undefined;
  if (errors.newPassword !== undefined) newPasswordError = t('resetPassword.newPasswordRequired');
  else if (notice?.kind === 'policy') {
    newPasswordError =
      notice.rule === undefined
        ? t('passwordPolicy.failed')
        : t('passwordPolicy.ruleFailed', {
            rule: t(`passwordPolicy.rules.${notice.rule}`),
            // React escapes the text; i18next must not escape it again.
            interpolation: { escapeValue: false },
          });
  }

  let confirmationError: string | undefined;
  if (errors.confirmation?.type === 'mismatch') {
    confirmationError = t('resetPassword.confirmationMismatch');
  } else if (errors.confirmation !== undefined) {
    confirmationError = t('resetPassword.confirmationRequired');
  }

  return (
    <>
      {notice !== undefined && <NoticeAlert key={answers} notice={notice} />}
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label={t('resetPassword.newPassword')}
          error={newPasswordError}
          type="password"
          autoComplete="new-password"
          {...register('newPassword')}
        />
        <Field
          label={t('resetPassword.confirmation')}
          error={confirmationError}
          type="password"
          autoComplete="new-password"
          {...register('confirmation')}
        />
        {factorStep !== undefined && (
          <>
            <p className="text-sm text-muted-foreground">{t('resetPassword.factorRequired')}</p>
            <Field
              label={t(factorStep === 'totp' ? 'resetPassword.code' : 'resetPassword.backupCode')}
              error={errors.code === undefined ? undefined : t('resetPassword.codeRequired')}
              type="text"
              autoComplete="one-time-code"
              {...register('code')}
            />
          </>
        )}
        <Button type="submit">{t('resetPassword.submit')}</Button>
        {factorStep === 'totp' && (
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setValue('code', '');
              clearErrors('code');
              setFactorStep('backup');
            }}
          >
            {t('resetPassword.useBackupCode')}
          </Button>
        )}
      </form>
    </>
  );
}

/** The page's state: the form, or one of the two outcomes that replace it. */
type PageState = 'form' | 'invalidLink' | 'completed';

function ResetPasswordContent({ link }: { link: ResetLink | undefined }): React.JSX.Element {
  const { t } = useTranslation('auth');
  const [state, setState] = useState<PageState>(link === undefined ? 'invalidLink' : 'form');

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('resetPassword.title')}</h1>
      {state === 'invalidLink' && (
        <Alert variant="destructive">{t('resetPassword.invalidLink')}</Alert>
      )}
      {state === 'completed' && (
        <>
          <p role="status">{t('resetPassword.completed')}</p>
          <Link to="/sign-in" className="underline underline-offset-4">
            {t('resetPassword.signIn')}
          </Link>
        </>
      )}
      {state === 'form' && link !== undefined && (
        <ResetForm
          link={link}
          onInvalidLink={() => {
            setState('invalidLink');
          }}
          onCompleted={() => {
            setState('completed');
          }}
        />
      )}
    </main>
  );
}

/**
 * The `/reset-password` page. The fragment is taken here, outside the `Suspense` boundary
 * of the on-demand `auth` namespace, so a suspended render cannot drop it.
 */
export function ResetPasswordPage(): React.JSX.Element {
  const [link] = useState(takeResetLink);
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent link={link} />
    </Suspense>
  );
}
