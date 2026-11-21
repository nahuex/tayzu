/**
 * The local sign-in forms (design D11 and Q20, Q71), shared by the sign-in page and the
 * embedded sign-in of the accept-invitation page.
 *
 * Each form checks only emptiness, sends its one request on the user's submit, empties
 * its secret field (the password, or the code) after the request, and hands the result
 * to its page, which decides what the answer means. Only the submit label differs
 * between the pages.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { AuthResult } from '../api/auth-client.js';

import { Field } from './field.js';

/** Only emptiness is checked here; the server decides everything else (Q71). */
const credentialsSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });
const codeSchema = z.object({ code: z.string().min(1) });

type Credentials = z.input<typeof credentialsSchema>;
type Code = z.input<typeof codeSchema>;

/** The second factor the code step verifies. */
export type CodeStep = 'totp' | 'backup';

/** Email and password, then `POST /api/auth/sign-in/email`. */
export function CredentialsForm({
  submitLabel,
  onResult,
}: {
  submitLabel: string;
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
      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}

/** The second factor: an authentication code, with a switch to a backup code. */
export function CodeForm({
  step,
  submitLabel,
  onResult,
  onUseBackupCode,
}: {
  step: CodeStep;
  submitLabel: string;
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
      <Button type="submit">{submitLabel}</Button>
      {step === 'totp' && (
        <Button type="button" variant="link" onClick={onUseBackupCode}>
          {t('signIn.useBackupCode')}
        </Button>
      )}
    </form>
  );
}
