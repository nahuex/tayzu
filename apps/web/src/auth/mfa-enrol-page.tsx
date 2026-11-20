/**
 * MFA enrolment and re-enrolment (design D10, D11, D12, D15 and Q17, Q71, Q74), the page
 * of the `mfa_enrolment_required` gate, also reached from the user menu when the user is
 * not enrolled. Re-enrolment after an MFA reset is the same page.
 *
 * Three steps:
 *
 * 1. The password, then `POST /api/auth/two-factor/enable`. A wrong password marks the
 *    field; anything else is one generic alert. The field is emptied after every request.
 * 2. The TOTP URI as an inline SVG QR code (`QRCodeSVG`, with no `style` and no image, so
 *    the strict `style-src` and `img-src` of D10 allow it), its `secret` as text for
 *    manual entry, and the backup codes, shown until the user confirms they saved them.
 * 3. A code, `POST /api/auth/two-factor/verify-totp`. Every failure is one message and
 *    keeps this step. Better Auth refuses a wrong code with a `401`, which here is a
 *    refused code, not a lost session: the page calls the auth client directly, never
 *    through the query or mutation cache, so the shell's session-end listener never sees
 *    it (and the page is not in the shell). On success the cached session is removed, so
 *    the session gate reads `GET /v1/me` again, and the page goes to the route's
 *    validated `returnTo`.
 *
 * The password, the URI, the secret and the codes live only in this page's component and
 * form state: never in the query cache, storage or the URL. Leaving the page drops them,
 * and a return starts again from the password. No server text is ever shown.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { QRCodeSVG } from 'qrcode.react';
import { Suspense, useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { ApiError } from '../api/errors.js';
import { SESSION_QUERY_KEY } from '../app/session-gate.js';

import { Field } from './field.js';
import { returnToOf } from './route-search.js';
import { SignOutButton } from './sign-out-button.js';

/** Only emptiness is checked here; the server decides everything else. */
const passwordSchema = z.object({ password: z.string().min(1) });
const codeSchema = z.object({ code: z.string().min(1) });

type PasswordValues = z.input<typeof passwordSchema>;
type CodeValues = z.input<typeof codeSchema>;

/** What `/two-factor/enable` returned, kept in component state only. */
interface Enrolment {
  readonly totpURI: string;
  readonly secret: string;
  readonly backupCodes: readonly string[];
}

/** The page's step. The verification step holds nothing: the codes are never shown again. */
type Step =
  | { readonly kind: 'password' }
  | { readonly kind: 'codes'; readonly enrolment: Enrolment }
  | { readonly kind: 'verify' };

/** What a failed enable means for the page; never anything the server wrote. */
type EnableFailure = 'passwordIncorrect' | 'failed';

function enableFailureOf(error: ApiError): EnableFailure {
  return error.kind === 'validation' &&
    error.issues.some((issue) => issue.path === '/currentPassword')
    ? 'passwordIncorrect'
    : 'failed';
}

/** The `secret` parameter of an `otpauth:` URI, or `undefined` when there is none. */
function secretOf(totpURI: string): string | undefined {
  if (!URL.canParse(totpURI)) return undefined;
  const url = new URL(totpURI);
  if (url.protocol !== 'otpauth:') return undefined;
  const secret = url.searchParams.get('secret');
  return secret === null || secret === '' ? undefined : secret;
}

function PasswordStep({ onEnabled }: { onEnabled: (enrolment: Enrolment) => void }) {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const [failure, setFailure] = useState<EnableFailure | undefined>(undefined);
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema) });

  const submit = handleSubmit(async ({ password }) => {
    setFailure(undefined);
    const result = await authClient.enableTwoFactor({ password });
    setValue('password', '');
    if (result.ok) {
      const secret = secretOf(result.value.totpURI);
      if (secret !== undefined) {
        onEnabled({
          totpURI: result.value.totpURI,
          secret,
          backupCodes: result.value.backupCodes,
        });
        return;
      }
    }
    // A URI without a secret cannot be enrolled: fail closed, like a server failure.
    setFailure(result.ok ? 'failed' : enableFailureOf(result.error));
    setAnswers((count) => count + 1);
  });

  let passwordError: string | undefined;
  if (errors.password !== undefined) passwordError = t('mfaEnrol.passwordRequired');
  else if (failure === 'passwordIncorrect') passwordError = t('mfaEnrol.passwordIncorrect');

  return (
    <>
      {failure === 'failed' && (
        <Alert key={answers} variant="destructive">
          {t('mfaEnrol.failed')}
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">{t('mfaEnrol.passwordDescription')}</p>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label={t('mfaEnrol.password')}
          error={passwordError}
          type="password"
          autoComplete="current-password"
          {...register('password')}
        />
        <Button type="submit" disabled={isSubmitting}>
          {t('mfaEnrol.continue')}
        </Button>
      </form>
    </>
  );
}

function CodesStep({ enrolment, onSaved }: { enrolment: Enrolment; onSaved: () => void }) {
  const { t } = useTranslation('auth');
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [saved, setSaved] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const savedErrorId = `${id}-saved-error`;

  // The step replaced the form the user was in: keep the keyboard focus in the page.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (saved) onSaved();
        else setUnconfirmed(true);
      }}
    >
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {t('mfaEnrol.scanTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('mfaEnrol.scanDescription')}</p>
      <QRCodeSVG value={enrolment.totpURI} title={t('mfaEnrol.qrTitle')} />
      <p className="text-sm text-muted-foreground">{t('mfaEnrol.secretDescription')}</p>
      <code className="font-mono text-sm break-all">{enrolment.secret}</code>
      <h2 id={`${id}-codes`} className="text-lg font-semibold">
        {t('mfaEnrol.backupCodes')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('mfaEnrol.backupCodesDescription')}</p>
      <ul aria-labelledby={`${id}-codes`} className="grid grid-cols-2 gap-1 font-mono text-sm">
        {enrolment.backupCodes.map((code, index) => (
          // The server's order is the identity: two equal codes stay two items.
          <li key={index}>{code}</li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-saved`}
          type="checkbox"
          checked={saved}
          aria-invalid={unconfirmed && !saved ? true : undefined}
          aria-describedby={unconfirmed && !saved ? savedErrorId : undefined}
          onChange={(event) => {
            setSaved(event.target.checked);
          }}
        />
        <label htmlFor={`${id}-saved`} className="text-sm">
          {t('mfaEnrol.saved')}
        </label>
      </div>
      {unconfirmed && !saved && (
        <p id={savedErrorId} className="text-sm text-destructive">
          {t('mfaEnrol.savedRequired')}
        </p>
      )}
      <Button type="submit">{t('mfaEnrol.continue')}</Button>
    </form>
  );
}

function VerifyStep({ onVerified }: { onVerified: () => void }) {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const [refused, setRefused] = useState(false);
  const [answers, setAnswers] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<CodeValues>({ resolver: zodResolver(codeSchema) });

  useEffect(() => {
    setFocus('code');
  }, [setFocus]);

  const submit = handleSubmit(async ({ code }) => {
    setRefused(false);
    const result = await authClient.verifyTotp({ code });
    setValue('code', '');
    if (result.ok) {
      onVerified();
      return;
    }
    setRefused(true);
    setAnswers((count) => count + 1);
  });

  return (
    <>
      {refused && (
        <Alert key={answers} variant="destructive">
          {t('mfaEnrol.invalidCode')}
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">{t('mfaEnrol.verifyDescription')}</p>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label={t('mfaEnrol.code')}
          error={errors.code === undefined ? undefined : t('mfaEnrol.codeRequired')}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          {...register('code')}
        />
        <Button type="submit" disabled={isSubmitting}>
          {t('mfaEnrol.verify')}
        </Button>
      </form>
    </>
  );
}

function MfaEnrolContent(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const search: unknown = useSearch({ from: '/mfa/enrol' });
  const returnTo = returnToOf(search);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'password' });

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('mfaEnrol.title')}</h1>
      {step.kind === 'password' && (
        <PasswordStep
          onEnabled={(enrolment) => {
            setStep({ kind: 'codes', enrolment });
          }}
        />
      )}
      {step.kind === 'codes' && (
        <CodesStep
          enrolment={step.enrolment}
          onSaved={() => {
            setStep({ kind: 'verify' });
          }}
        />
      )}
      {step.kind === 'verify' && (
        <VerifyStep
          onVerified={() => {
            queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
            router.history.push(returnTo);
          }}
        />
      )}
      <SignOutButton />
    </main>
  );
}

/** The `/mfa/enrol` page. The `auth` namespace loads on demand, inside its own boundary. */
export function MfaEnrolPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <MfaEnrolContent />
    </Suspense>
  );
}
