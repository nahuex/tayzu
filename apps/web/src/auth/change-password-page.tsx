/**
 * The temporary-password change (design D11, D12, D15 and Q63, Q71, Q73), the page of
 * the `password_change_required` gate.
 *
 * Current (temporary) password, new password and confirmation, then
 * `POST /api/auth/change-password` with `revokeOtherSessions: true`. Only emptiness and
 * the confirmation are checked here; the server decides the policy. A policy failure
 * shows the localized name of the failed rule, which is all the API returns; a wrong
 * current password marks that field; anything else is one generic alert. No server
 * text is ever shown, and every password field is emptied after every request.
 *
 * On success the cached session is removed, so the session gate reads `GET /v1/me` again
 * (it reads with `staleTime: 'static'`), and the page goes to the route's validated
 * `returnTo`, query included.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { ApiError, PasswordRule } from '../api/errors.js';
import { SESSION_QUERY_KEY } from '../app/session-gate.js';

import { Field } from './field.js';
import { returnToOf } from './route-search.js';
import { SignOutButton } from './sign-out-button.js';

const changeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
  confirmation: z.string().min(1),
});

type ChangeValues = z.input<typeof changeSchema>;

/** What the server's refusal means for the page; never anything the server wrote. */
type Failure =
  | { readonly kind: 'currentIncorrect' }
  | { readonly kind: 'policy'; readonly rule?: PasswordRule }
  | { readonly kind: 'failed' };

/** The page's reading of a failed change: only the kind and the issue paths count. */
function failureOf(error: ApiError): Failure {
  if (error.kind !== 'validation') return { kind: 'failed' };
  if (error.issues.some((issue) => issue.path === '/currentPassword')) {
    return { kind: 'currentIncorrect' };
  }
  const policy = error.issues.find((issue) => issue.path === '/newPassword');
  if (policy === undefined) return { kind: 'failed' };
  return policy.rule === undefined ? { kind: 'policy' } : { kind: 'policy', rule: policy.rule };
}

function ChangePasswordContent(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const search: unknown = useSearch({ from: '/change-password' });
  const returnTo = returnToOf(search);
  const router = useRouter();
  const queryClient = useQueryClient();
  const authClient = useAuthClient();
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors },
  } = useForm<ChangeValues>({ resolver: zodResolver(changeSchema) });

  const submit = handleSubmit(async ({ currentPassword, newPassword, confirmation }) => {
    if (confirmation !== newPassword) {
      setError('confirmation', { type: 'mismatch' });
      return;
    }
    setFailure(undefined);
    const result = await authClient.changePassword({ currentPassword, newPassword });
    setValue('currentPassword', '');
    setValue('newPassword', '');
    setValue('confirmation', '');
    if (result.ok) {
      queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
      router.history.push(returnTo);
      return;
    }
    setFailure(failureOf(result.error));
    setAnswers((count) => count + 1);
  });

  let currentError: string | undefined;
  if (errors.currentPassword !== undefined) {
    currentError = t('changePassword.currentPasswordRequired');
  } else if (failure?.kind === 'currentIncorrect') {
    currentError = t('changePassword.currentPasswordIncorrect');
  }

  let newError: string | undefined;
  if (errors.newPassword !== undefined) newError = t('changePassword.newPasswordRequired');
  else if (failure?.kind === 'policy') {
    newError =
      failure.rule === undefined
        ? t('passwordPolicy.failed')
        : t('passwordPolicy.ruleFailed', {
            rule: t(`passwordPolicy.rules.${failure.rule}`),
            // React escapes the text; i18next must not escape it again.
            interpolation: { escapeValue: false },
          });
  }

  let confirmationError: string | undefined;
  if (errors.confirmation?.type === 'mismatch') {
    confirmationError = t('changePassword.confirmationMismatch');
  } else if (errors.confirmation !== undefined) {
    confirmationError = t('changePassword.confirmationRequired');
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('changePassword.title')}</h1>
      {failure?.kind === 'failed' && (
        <Alert key={answers} variant="destructive">
          {t('changePassword.failed')}
        </Alert>
      )}
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label={t('changePassword.currentPassword')}
          error={currentError}
          type="password"
          autoComplete="current-password"
          {...register('currentPassword')}
        />
        <Field
          label={t('changePassword.newPassword')}
          error={newError}
          type="password"
          autoComplete="new-password"
          {...register('newPassword')}
        />
        <Field
          label={t('changePassword.confirmation')}
          error={confirmationError}
          type="password"
          autoComplete="new-password"
          {...register('confirmation')}
        />
        <Button type="submit">{t('changePassword.submit')}</Button>
      </form>
      <SignOutButton />
    </main>
  );
}

/** The `/change-password` page. The `auth` namespace loads on demand, inside its own boundary. */
export function ChangePasswordPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <ChangePasswordContent />
    </Suspense>
  );
}
