/**
 * The forgot-password page, `/forgot-password` (design D11, D12, D15 and Q23, Q71, Q77).
 *
 * One email field posts `POST /v1/auth/password-reset/request` on the user's submit, with
 * the address as typed (no format rule: the server decides). Every answer but a rate limit
 * (a success, any 4xx or 5xx, a network failure) replaces the form with the same status
 * message, which never echoes the address, so the page cannot tell whether an account
 * exists. A rate limit keeps the form and says when to try again, as on sign-in. The page
 * is public: it never reads the session.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';

import { Field } from './field.js';

/** Only emptiness is checked here; the server decides everything else (Q71). */
const requestSchema = z.object({ email: z.string().min(1) });

type ResetRequest = z.input<typeof requestSchema>;

/** The rate limit's answer, as the page shows it; `undefined` seconds means "later". */
interface RateLimited {
  readonly retryAfterSeconds: number | undefined;
}

function RateLimitedAlert({ notice }: { notice: RateLimited }): React.JSX.Element {
  const { t } = useTranslation('auth');
  const seconds = notice.retryAfterSeconds;
  return (
    <Alert variant="destructive">
      {seconds === undefined || seconds < 1
        ? t('forgotPassword.rateLimitedLater')
        : t('forgotPassword.rateLimited', { count: seconds })}
    </Alert>
  );
}

function RequestForm({
  onRateLimited,
  onSent,
}: {
  onRateLimited: (notice: RateLimited) => void;
  onSent: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetRequest>({ resolver: zodResolver(requestSchema) });

  const submit = handleSubmit(async ({ email }) => {
    const result = await authClient.requestPasswordReset({ email });
    if (!result.ok && result.error.kind === 'rate_limited') {
      onRateLimited({ retryAfterSeconds: result.error.retryAfterSeconds });
    } else onSent();
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
        label={t('forgotPassword.email')}
        error={errors.email === undefined ? undefined : t('forgotPassword.emailRequired')}
        type="email"
        autoComplete="username"
        {...register('email')}
      />
      <Button type="submit">{t('forgotPassword.submit')}</Button>
    </form>
  );
}

function ForgotPasswordContent(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState<RateLimited | undefined>(undefined);
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('forgotPassword.title')}</h1>
      {sent ? (
        <p role="status">{t('forgotPassword.sent')}</p>
      ) : (
        <>
          {notice !== undefined && <RateLimitedAlert key={answers} notice={notice} />}
          <RequestForm
            onRateLimited={(next) => {
              setNotice(next);
              setAnswers((count) => count + 1);
            }}
            onSent={() => {
              setNotice(undefined);
              setSent(true);
            }}
          />
        </>
      )}
      <Link to="/sign-in" className="underline underline-offset-4">
        {t('forgotPassword.back')}
      </Link>
    </main>
  );
}

/** The `/forgot-password` page. The `auth` namespace loads on demand, inside its own boundary. */
export function ForgotPasswordPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordContent />
    </Suspense>
  );
}
