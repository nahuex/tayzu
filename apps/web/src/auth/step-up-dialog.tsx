/**
 * The step-up dialog (design D11, Step-up dialog, D12, D16 and Q69, Q74, Q75), mounted
 * once by the shell. It opens while the step-up store (`../state/step-up.ts`) holds a
 * request, and settles it: `verified` after a successful local verification, `cancelled`
 * on Cancel or `Escape`. `withStepUp` then retries the original call once, or fails it.
 *
 * The variant follows the session (`signInMethod`, `mfa.enrolled` of `GET /v1/me`), never
 * the answer, because a local factor never satisfies a Visma Connect session:
 *
 * - a local session with MFA: a TOTP code, `/two-factor/verify-totp`, with a switch to a
 *   backup code, `/two-factor/verify-backup-code`. Every failed check is one message;
 *   Better Auth refuses a wrong code with a `401`, which here is a refused code, not a
 *   lost session (Q74);
 * - a local session without MFA: the password, `/api/auth/verify-password`. A wrong
 *   password marks the field; anything else is one generic alert;
 * - a Visma Connect session: no local field and no local call. With an absolute `https:`
 *   `reauthorizationUrl`, a "Continue with Visma Connect" button; its click stores the
 *   router's current path (`./step-up-return.js`) and leaves for the URL, and never
 *   settles `verified`, so nothing is retried: the user repeats the action on return
 *   (Q14, Q76). Without one (or with any other value, fail closed as Q72), a "try again
 *   in a few minutes" message.
 *
 * The auth client is called directly, never through the query or mutation cache, so no
 * code or password reaches the cache and the shell's session-end listener never sees a
 * refused code. The field is emptied after every request. No server text is ever shown.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { useAuthClient } from '../api/auth-client-context.js';
import type { AuthResult, Me } from '../api/auth-client.js';
import type { ApiError } from '../api/errors.js';
import { isAbsoluteHttpsUrl } from '../lib/external-url.js';
import { navigateToExternal } from '../lib/navigate-away.js';
import { useStepUpStore, type StepUpOutcome } from '../state/step-up.js';

import { Field } from './field.js';
import { saveStepUpReturnPath } from './step-up-return.js';

/** Only emptiness is checked here; the server decides everything else. */
const codeSchema = z.object({ code: z.string().min(1) });
const passwordSchema = z.object({ password: z.string().min(1) });

type CodeValues = z.input<typeof codeSchema>;
type PasswordValues = z.input<typeof passwordSchema>;

type CodeKind = 'totp' | 'backup';

/** What the session offers to verify with: chosen from the session, never the answer. */
type Variant = 'code' | 'password' | 'sso';

function variantOf(me: Pick<Me, 'signInMethod' | 'mfa'> | undefined): Variant {
  // No session read yet: offer no local factor, like a Visma Connect session (fail closed).
  if (me?.signInMethod !== 'password') return 'sso';
  return me.mfa.enrolled ? 'code' : 'password';
}

/** Closes the dialog and settles the waiting call. */
function settleStepUp(outcome: StepUpOutcome): void {
  useStepUpStore.getState().settleStepUp(outcome);
}

function isPasswordRefusal(error: ApiError): boolean {
  return (
    error.kind === 'validation' && error.issues.some((issue) => issue.path === '/currentPassword')
  );
}

interface VerifyProps {
  readonly onVerified: () => void;
}

function CodeForm({
  kind,
  onVerified,
  onUseBackupCode,
}: VerifyProps & { kind: CodeKind; onUseBackupCode: () => void }): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const [refused, setRefused] = useState(false);
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<CodeValues>({ resolver: zodResolver(codeSchema) });

  // The backup-code switch replaced the field the user was in: keep focus in the dialog.
  useEffect(() => {
    if (kind === 'backup') setFocus('code');
  }, [kind, setFocus]);

  const submit = handleSubmit(async ({ code }) => {
    setRefused(false);
    const result: AuthResult<void> =
      kind === 'totp'
        ? await authClient.verifyTotp({ code })
        : await authClient.verifyBackupCode({ code });
    setValue('code', '');
    if (result.ok) {
      onVerified();
      return;
    }
    setRefused(true);
    setAnswers((count) => count + 1);
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {refused && (
        <Alert key={answers} variant="destructive">
          {t('stepUp.invalidCode')}
        </Alert>
      )}
      <Field
        label={t(kind === 'totp' ? 'stepUp.code' : 'stepUp.backupCode')}
        error={errors.code === undefined ? undefined : t('stepUp.codeRequired')}
        type="text"
        autoComplete="one-time-code"
        {...register('code')}
      />
      <Button type="submit" disabled={isSubmitting}>
        {t('stepUp.verify')}
      </Button>
      {kind === 'totp' && (
        <Button type="button" variant="link" onClick={onUseBackupCode}>
          {t('stepUp.useBackupCode')}
        </Button>
      )}
    </form>
  );
}

function PasswordForm({ onVerified }: VerifyProps): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const [failure, setFailure] = useState<'passwordIncorrect' | 'failed' | undefined>(undefined);
  const [answers, setAnswers] = useState(0);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({ resolver: zodResolver(passwordSchema) });

  const submit = handleSubmit(async ({ password }) => {
    setFailure(undefined);
    const result = await authClient.verifyPassword({ password });
    setValue('password', '');
    if (result.ok) {
      onVerified();
      return;
    }
    setFailure(isPasswordRefusal(result.error) ? 'passwordIncorrect' : 'failed');
    setAnswers((count) => count + 1);
  });

  let passwordError: string | undefined;
  if (errors.password !== undefined) passwordError = t('stepUp.passwordRequired');
  else if (failure === 'passwordIncorrect') passwordError = t('stepUp.passwordIncorrect');

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === 'failed' && (
        <Alert key={answers} variant="destructive">
          {t('stepUp.failed')}
        </Alert>
      )}
      <Field
        label={t('stepUp.password')}
        error={passwordError}
        type="password"
        autoComplete="current-password"
        {...register('password')}
      />
      <Button type="submit" disabled={isSubmitting}>
        {t('stepUp.verify')}
      </Button>
    </form>
  );
}

/**
 * The Visma Connect step-up: no local factor and no local call, since none satisfies an
 * SSO session. The round trip starts only on the click, and only to an absolute `https:`
 * URL; the dialog stays open until the browser leaves.
 */
function SsoStepUp(): React.JSX.Element {
  const { t } = useTranslation('auth');
  const router = useRouter();
  const url = useStepUpStore((state) => state.request?.reauthorizationUrl);

  if (url === undefined || !isAbsoluteHttpsUrl(url)) return <p>{t('stepUp.ssoUnavailable')}</p>;
  return (
    <Button
      type="button"
      onClick={() => {
        // The router's location, never `window.location`, and never its fragment.
        const { pathname, search } = router.history.location;
        saveStepUpReturnPath(`${pathname}${search}`);
        navigateToExternal(url);
      }}
    >
      {t('stepUp.vismaConnect')}
    </Button>
  );
}

function CodeStepUp({ onVerified }: VerifyProps): React.JSX.Element {
  const [kind, setKind] = useState<CodeKind>('totp');
  return (
    <CodeForm
      key={kind}
      kind={kind}
      onVerified={onVerified}
      onUseBackupCode={() => {
        setKind('backup');
      }}
    />
  );
}

function StepUpContent({
  variant,
  onVerified,
  onCancel,
}: VerifyProps & {
  variant: Variant;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const returnFocus = useRef<Element | null>(null);

  return (
    <DialogContent
      showCloseButton={false}
      onOpenAutoFocus={() => {
        // The focus is still where the user acted (the page's trigger): it returns there.
        returnFocus.current = document.activeElement;
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) {
          returnFocus.current.focus();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('stepUp.title')}</DialogTitle>
        <DialogDescription>{t('stepUp.description')}</DialogDescription>
      </DialogHeader>
      {variant === 'code' && <CodeStepUp onVerified={onVerified} />}
      {variant === 'password' && <PasswordForm onVerified={onVerified} />}
      {variant === 'sso' && <SsoStepUp />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('stepUp.cancel')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * The one step-up dialog of the app. `me` is the shell's session read. The `auth`
 * namespace loads only when a request opens the dialog, inside its own boundary.
 */
export function StepUpDialog({
  me,
}: {
  me: Pick<Me, 'signInMethod' | 'mfa'> | undefined;
}): React.JSX.Element {
  const open = useStepUpStore((state) => state.request !== null);
  const variant = variantOf(me);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settleStepUp('cancelled');
      }}
    >
      {open && (
        <Suspense fallback={null}>
          <StepUpContent
            variant={variant}
            onVerified={() => {
              settleStepUp('verified');
            }}
            onCancel={() => {
              settleStepUp('cancelled');
            }}
          />
        </Suspense>
      )}
    </Dialog>
  );
}
