/**
 * The invitation page, `/accept-invitation` (design D11, D12, D15, D16 and Q20, Q68, Q71,
 * Q78, Q79; archived `043` D4 and Q32).
 *
 * The link is `/accept-invitation#invitation=<id>&token=<token>`. As on the reset page,
 * the fragment is taken in the page's `useState` initializer, outside its `Suspense`
 * boundary, and removed there with `history.replaceState`, so it is gone from the
 * address before the first commit and before any request; the id and token then live
 * only in that state. The format (an id of 1 to 64 characters of `[A-Za-z0-9_-]`, a
 * 43-character base64url token) is checked here, because the server answers a malformed
 * body with a non-uniform `400`: a missing or malformed fragment shows the same
 * invalid-link alert as the server's uniform `404`, with no form and no choice.
 *
 * Nothing is sent before a click (Q79). The page first offers two choices:
 *
 * - "Create a new account": a password and its confirmation, then the accept with
 *   `password`. That creates the account and opens no session, so the page ends on a
 *   link to `/sign-in`.
 * - "I already have an account": reads `GET /v1/me` on that click (the page's own
 *   signed-in check, Q68). A session offers "Accept invitation"; a `401` shows the
 *   embedded local sign-in (Q20), which accepts on its last submit and never leaves the
 *   route, with a note telling a Visma Connect user to sign in first and open the link
 *   again. Both session paths send the accept without `password`, remove the cached
 *   session so the gate reads it again, and end on a "Continue" link to `/`.
 *
 * A session-path accept answered `step_up_required` (an `admin` invitation on a session
 * with no fresh verification) shows the page's own step-up step, never the shell's
 * dialog, which public pages do not mount (Q80). The variant follows the session, never
 * the answer, from what the page already read: `GET /v1/me` on the signed-in path, the
 * sign-in itself (a code exactly when it asked for one) on the embedded path. A code or
 * the password (`/verify-password`) is verified, then the accept is retried exactly once;
 * a refused factor keeps the step with one alert, and a second `step_up_required` is the
 * generic alert. A Visma Connect session gets a note and, for an absolute `https:`
 * `reauthorizationUrl`, a button whose click stores only the return path (`/`, since this
 * page is public) and leaves for the URL; the id and token are never stored.
 *
 * Every `not_found` answer is the invalid-link alert. A rate limit says when to try
 * again, a password-policy failure shows the localized name of the failed rule, and
 * anything else is one generic alert; no server text is ever shown. Password and code
 * fields are emptied after every request. The page calls the auth client directly,
 * never through the query or mutation cache, so neither the id, the token, a password
 * nor a code reaches either cache.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import type { AuthResult, Me } from '../api/auth-client.js';
import type { ApiError, PasswordRule } from '../api/errors.js';
import { SESSION_QUERY_KEY } from '../app/session-gate.js';
import { isAbsoluteHttpsUrl } from '../lib/external-url.js';
import { navigateToExternal } from '../lib/navigate-away.js';

import { Field } from './field.js';
import { CodeForm, CredentialsForm, type CodeStep } from './sign-in-forms.js';
import { saveStepUpReturnPath } from './step-up-return.js';

/** The invitation link's values, kept in component state only. */
interface InvitationLink {
  readonly invitationId: string;
  readonly token: string;
}

/** The accept route's id (Better Auth's) and `043` D4's token (32 bytes, base64url). */
const INVITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads the invitation link from the fragment and removes the fragment from the address,
 * in the same synchronous call. `undefined` for a missing or malformed link.
 */
function takeInvitationLink(): InvitationLink | undefined {
  const { hash, href, pathname, search } = window.location;
  if (href.includes('#')) {
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
  }
  const params = new URLSearchParams(hash.slice(1));
  const invitationId = params.get('invitation');
  const token = params.get('token');
  if (invitationId === null || token === null) return undefined;
  if (!INVITATION_ID_PATTERN.test(invitationId) || !TOKEN_PATTERN.test(token)) return undefined;
  return { invitationId, token };
}

/** What the session verifies with on the step-up step (Q80), as the shell's dialog (Q75). */
type StepUpVariant = 'code' | 'password' | 'sso';

/** Chosen from the session, never the answer: no local factor satisfies an SSO session. */
function stepUpVariantOf(me: Pick<Me, 'signInMethod' | 'mfa'>): StepUpVariant {
  if (me.signInMethod !== 'password') return 'sso';
  return me.mfa.enrolled ? 'code' : 'password';
}

/** The session the accept runs on. */
interface SessionInfo {
  /** Unknown after the embedded sign-in, which reads no session. */
  readonly email?: string;
  readonly stepUp: StepUpVariant;
}

/** Where the page is (Q79); `invalid` is final. */
type PageState =
  | { readonly kind: 'choice' }
  | { readonly kind: 'new' }
  | { readonly kind: 'signIn' }
  | { readonly kind: 'code'; readonly step: CodeStep }
  | { readonly kind: 'signedIn'; readonly session: SessionInfo }
  | {
      readonly kind: 'stepUp';
      readonly session: SessionInfo;
      readonly reauthorizationUrl?: string;
    }
  | { readonly kind: 'created' }
  | { readonly kind: 'joined' }
  | { readonly kind: 'invalid' };

/** What the page's one alert says; never anything the server wrote. */
type Notice =
  | { readonly kind: 'failed' }
  | { readonly kind: 'signInFailed' }
  | { readonly kind: 'invalidCode' }
  | { readonly kind: 'stepUpInvalidCode' }
  | { readonly kind: 'stepUpPasswordIncorrect' }
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds?: number };

/** A refusal's notice: a rate limit is told apart, anything else is `fallback`. */
function noticeOf(error: ApiError, fallback: Notice): Notice {
  if (error.kind !== 'rate_limited') return fallback;
  return error.retryAfterSeconds === undefined
    ? { kind: 'rateLimited' }
    : { kind: 'rateLimited', retryAfterSeconds: error.retryAfterSeconds };
}

/** A new account's password-policy failure, with the rule when the server named a known one. */
interface PolicyFailure {
  readonly rule?: PasswordRule;
}

function policyFailureOf(error: ApiError): PolicyFailure | undefined {
  if (error.kind !== 'validation') return undefined;
  const issue = error.issues.find((candidate) => candidate.path === '/password');
  if (issue === undefined) return undefined;
  return issue.rule === undefined ? {} : { rule: issue.rule };
}

function NoticeAlert({ notice }: { notice: Notice }): React.JSX.Element {
  const { t } = useTranslation('auth');
  let text: string;
  if (notice.kind !== 'rateLimited') text = t(`acceptInvitation.${notice.kind}`);
  else if (notice.retryAfterSeconds === undefined || notice.retryAfterSeconds < 1) {
    text = t('acceptInvitation.rateLimitedLater');
  } else text = t('acceptInvitation.rateLimited', { count: notice.retryAfterSeconds });
  return <Alert variant="destructive">{text}</Alert>;
}

function InvalidLinkAlert(): React.JSX.Element {
  const { t } = useTranslation('auth');
  return <Alert variant="destructive">{t('acceptInvitation.invalidLink')}</Alert>;
}

/** Only emptiness and the confirmation are checked here; the server decides the rest. */
const newAccountSchema = z.object({
  password: z.string().min(1),
  confirmation: z.string().min(1),
});

type NewAccountValues = z.input<typeof newAccountSchema>;

/** The new-account path: a password and its confirmation, then the accept with it. */
function NewAccountForm({
  link,
  onCreated,
  onInvalidLink,
  onNotice,
}: {
  link: InvitationLink;
  onCreated: () => void;
  onInvalidLink: () => void;
  onNotice: (notice: Notice | undefined) => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const [policy, setPolicy] = useState<PolicyFailure | undefined>(undefined);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors },
  } = useForm<NewAccountValues>({
    resolver: zodResolver(newAccountSchema),
    defaultValues: { password: '', confirmation: '' },
  });

  const submit = handleSubmit(async ({ password, confirmation }) => {
    if (confirmation !== password) {
      setError('confirmation', { type: 'mismatch' });
      return;
    }
    setPolicy(undefined);
    onNotice(undefined);
    const result = await authClient.acceptInvitation({ ...link, password });
    setValue('password', '');
    setValue('confirmation', '');
    if (result.ok) {
      onCreated();
      return;
    }
    const { error } = result;
    if (error.kind === 'not_found') {
      onInvalidLink();
      return;
    }
    const failure = policyFailureOf(error);
    if (failure === undefined) onNotice(noticeOf(error, { kind: 'failed' }));
    else setPolicy(failure);
  });

  let passwordError: string | undefined;
  if (errors.password !== undefined) passwordError = t('acceptInvitation.passwordRequired');
  else if (policy !== undefined) {
    passwordError =
      policy.rule === undefined
        ? t('passwordPolicy.failed')
        : t('passwordPolicy.ruleFailed', {
            rule: t(`passwordPolicy.rules.${policy.rule}`),
            // React escapes the text; i18next must not escape it again.
            interpolation: { escapeValue: false },
          });
  }

  let confirmationError: string | undefined;
  if (errors.confirmation?.type === 'mismatch') {
    confirmationError = t('acceptInvitation.confirmationMismatch');
  } else if (errors.confirmation !== undefined) {
    confirmationError = t('acceptInvitation.confirmationRequired');
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field
        label={t('acceptInvitation.password')}
        error={passwordError}
        type="password"
        autoComplete="new-password"
        {...register('password')}
      />
      <Field
        label={t('acceptInvitation.confirmation')}
        error={confirmationError}
        type="password"
        autoComplete="new-password"
        {...register('confirmation')}
      />
      <Button type="submit">{t('acceptInvitation.createAndAccept')}</Button>
    </form>
  );
}

/** Only emptiness is checked here; the server decides everything else. */
const factorSchema = z.object({ value: z.string().min(1) });

type FactorValues = z.input<typeof factorSchema>;

/** The local factor the step-up form verifies. */
type FactorKind = 'totp' | 'backup' | 'password';

function isPasswordRefusal(error: ApiError): boolean {
  return (
    error.kind === 'validation' && error.issues.some((issue) => issue.path === '/currentPassword')
  );
}

/**
 * One local factor: a code (TOTP or backup) or the password, sent on the user's submit
 * only and emptied after the request. A verified factor resolves through `onVerified`,
 * which retries the accept; a refusal is one page notice and keeps the form.
 */
function StepUpFactorForm({
  kind,
  onVerified,
  onNotice,
  onUseBackupCode,
}: {
  kind: FactorKind;
  onVerified: () => Promise<void>;
  onNotice: (notice: Notice | undefined) => void;
  onUseBackupCode: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FactorValues>({ resolver: zodResolver(factorSchema) });

  // The step replaced the control the user was on: keep the keyboard focus in the page.
  useEffect(() => {
    setFocus('value');
  }, [setFocus]);

  const submit = handleSubmit(async ({ value }) => {
    onNotice(undefined);
    let result: AuthResult<void>;
    if (kind === 'totp') result = await authClient.verifyTotp({ code: value });
    else if (kind === 'backup') result = await authClient.verifyBackupCode({ code: value });
    else result = await authClient.verifyPassword({ password: value });
    setValue('value', '');
    if (result.ok) {
      await onVerified();
      return;
    }
    // A refused code (Better Auth's `401` included) is never a lost session (Q74).
    if (kind !== 'password') onNotice(noticeOf(result.error, { kind: 'stepUpInvalidCode' }));
    else if (isPasswordRefusal(result.error)) onNotice({ kind: 'stepUpPasswordIncorrect' });
    else onNotice(noticeOf(result.error, { kind: 'failed' }));
  });

  const isCode = kind !== 'password';
  let label: string;
  if (kind === 'totp') label = t('acceptInvitation.stepUpCode');
  else if (kind === 'backup') label = t('acceptInvitation.stepUpBackupCode');
  else label = t('acceptInvitation.stepUpPassword');
  let requiredError: string | undefined;
  if (errors.value !== undefined) {
    requiredError = t(
      isCode ? 'acceptInvitation.stepUpCodeRequired' : 'acceptInvitation.stepUpPasswordRequired',
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field
        label={label}
        error={requiredError}
        type={isCode ? 'text' : 'password'}
        autoComplete={isCode ? 'one-time-code' : 'current-password'}
        {...register('value')}
      />
      <Button type="submit" disabled={isSubmitting}>
        {t('acceptInvitation.stepUpSubmit')}
      </Button>
      {kind === 'totp' && (
        <Button type="button" variant="link" onClick={onUseBackupCode}>
          {t('acceptInvitation.stepUpUseBackupCode')}
        </Button>
      )}
    </form>
  );
}

/**
 * The Visma Connect step-up: no local factor and no request. The round trip starts only
 * on the click, and only to an absolute `https:` URL; it stores the router's current
 * path, which `safeReturnPath` turns into `/` here, and never the id or the token.
 */
function VismaConnectStepUp({
  reauthorizationUrl,
}: {
  reauthorizationUrl: string | undefined;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const router = useRouter();
  const url =
    reauthorizationUrl !== undefined && isAbsoluteHttpsUrl(reauthorizationUrl)
      ? reauthorizationUrl
      : undefined;
  return (
    <>
      <p>{t('acceptInvitation.stepUpVismaConnect')}</p>
      {url !== undefined && (
        <Button
          type="button"
          onClick={() => {
            // The router's location, never `window.location`, and never its fragment.
            const { pathname, search } = router.history.location;
            saveStepUpReturnPath(`${pathname}${search}`);
            navigateToExternal(url);
          }}
        >
          {t('acceptInvitation.stepUpVismaConnectContinue')}
        </Button>
      )}
    </>
  );
}

/** The page's own step-up step (Q80): the variant's intro and its factor, or the note. */
function StepUpStep({
  variant,
  reauthorizationUrl,
  onVerified,
  onNotice,
}: {
  variant: StepUpVariant;
  reauthorizationUrl: string | undefined;
  onVerified: () => Promise<void>;
  onNotice: (notice: Notice | undefined) => void;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const [codeKind, setCodeKind] = useState<'totp' | 'backup'>('totp');

  if (variant === 'sso') return <VismaConnectStepUp reauthorizationUrl={reauthorizationUrl} />;
  const kind: FactorKind = variant === 'password' ? 'password' : codeKind;
  return (
    <>
      <p>
        {t(
          variant === 'code'
            ? 'acceptInvitation.stepUpCodeIntro'
            : 'acceptInvitation.stepUpPasswordIntro',
        )}
      </p>
      <StepUpFactorForm
        key={kind}
        kind={kind}
        onVerified={onVerified}
        onNotice={onNotice}
        onUseBackupCode={() => {
          onNotice(undefined);
          setCodeKind('backup');
        }}
      />
    </>
  );
}

/** The page's states and transitions for a well-formed link (Q79). */
function InvitationFlow({ link }: { link: InvitationLink }): React.JSX.Element {
  const { t } = useTranslation('auth');
  const authClient = useAuthClient();
  const queryClient = useQueryClient();
  const [state, setState] = useState<PageState>({ kind: 'choice' });
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // Remounts the alert on every answer, so a repeated message is announced again.
  const [answers, setAnswers] = useState(0);

  function show(next: Notice | undefined): void {
    setNotice(next);
    setAnswers((count) => count + 1);
  }

  function go(next: PageState): void {
    setNotice(undefined);
    setState(next);
  }

  /** "I already have an account": the page's own signed-in check (Q68). */
  async function readSession(): Promise<void> {
    const result = await authClient.me();
    if (result.ok) {
      const { user, signInMethod, mfa } = result.value;
      go({
        kind: 'signedIn',
        session: { email: user.email, stepUp: stepUpVariantOf({ signInMethod, mfa }) },
      });
    } else if (result.error.kind === 'unauthenticated') go({ kind: 'signIn' });
    else show({ kind: 'failed' });
  }

  /**
   * The session path: the accept without `password`. A first `step_up_required` opens
   * the step-up step (Q80); `retried` marks the one retry after it, whose
   * `step_up_required` is a plain failure. A refusal other than `not_found` leaves the
   * page on "Accept invitation", since a session exists by then.
   */
  async function acceptWithSession(session: SessionInfo, retried = false): Promise<void> {
    const result = await authClient.acceptInvitation(link);
    if (result.ok) {
      queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
      go({ kind: 'joined' });
      return;
    }
    const { error } = result;
    if (error.kind === 'not_found') {
      go({ kind: 'invalid' });
      return;
    }
    if (error.kind === 'step_up_required' && !retried) {
      go(
        error.reauthorizationUrl === undefined
          ? { kind: 'stepUp', session }
          : { kind: 'stepUp', session, reauthorizationUrl: error.reauthorizationUrl },
      );
      return;
    }
    setState({ kind: 'signedIn', session });
    show(noticeOf(error, { kind: 'failed' }));
  }

  /**
   * The embedded sign-in succeeded: the session changed, then the accept follows. The
   * sign-in is always local, with MFA exactly when it went through a code.
   */
  function signedIn(stepUp: StepUpVariant): void {
    queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
    show(undefined);
    void acceptWithSession({ stepUp });
  }

  let content: React.JSX.Element;
  switch (state.kind) {
    case 'choice':
      content = (
        <>
          <p>{t('acceptInvitation.intro')}</p>
          <Button
            type="button"
            onClick={() => {
              go({ kind: 'new' });
            }}
          >
            {t('acceptInvitation.newAccount')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void readSession();
            }}
          >
            {t('acceptInvitation.existingAccount')}
          </Button>
        </>
      );
      break;
    case 'new':
      content = (
        <NewAccountForm
          link={link}
          onCreated={() => {
            go({ kind: 'created' });
          }}
          onInvalidLink={() => {
            go({ kind: 'invalid' });
          }}
          onNotice={show}
        />
      );
      break;
    case 'signIn':
      content = (
        <>
          <CredentialsForm
            submitLabel={t('acceptInvitation.signInAndAccept')}
            onResult={(result) => {
              if (!result.ok) show(noticeOf(result.error, { kind: 'signInFailed' }));
              else if (result.value.twoFactorRequired) go({ kind: 'code', step: 'totp' });
              else signedIn('password');
            }}
          />
          <p className="text-sm text-muted-foreground">{t('acceptInvitation.vismaConnectNote')}</p>
          <Link to="/sign-in" className="underline underline-offset-4">
            {t('acceptInvitation.goToSignIn')}
          </Link>
        </>
      );
      break;
    case 'code':
      content = (
        <CodeForm
          key={state.step}
          step={state.step}
          submitLabel={t('acceptInvitation.verifyAndAccept')}
          onResult={(result) => {
            if (result.ok) signedIn('code');
            else show(noticeOf(result.error, { kind: 'invalidCode' }));
          }}
          onUseBackupCode={() => {
            go({ kind: 'code', step: 'backup' });
          }}
        />
      );
      break;
    case 'signedIn': {
      const { session } = state;
      content = (
        <>
          {session.email !== undefined && (
            <p>
              {t('acceptInvitation.signedInAs', {
                email: session.email,
                // React escapes the text; i18next must not escape it again.
                interpolation: { escapeValue: false },
              })}
            </p>
          )}
          <Button
            type="button"
            onClick={() => {
              void acceptWithSession(session);
            }}
          >
            {t('acceptInvitation.accept')}
          </Button>
        </>
      );
      break;
    }
    case 'stepUp': {
      const { session } = state;
      content = (
        <StepUpStep
          variant={session.stepUp}
          reauthorizationUrl={state.reauthorizationUrl}
          onVerified={() => acceptWithSession(session, true)}
          onNotice={show}
        />
      );
      break;
    }
    case 'created':
      content = (
        <>
          <p role="status">{t('acceptInvitation.created')}</p>
          <Link to="/sign-in" className="underline underline-offset-4">
            {t('acceptInvitation.signIn')}
          </Link>
        </>
      );
      break;
    case 'joined':
      content = (
        <>
          <p role="status">{t('acceptInvitation.joined')}</p>
          <Link to="/" className="underline underline-offset-4">
            {t('acceptInvitation.continue')}
          </Link>
        </>
      );
      break;
    case 'invalid':
      return <InvalidLinkAlert />;
  }

  return (
    <>
      {notice !== undefined && <NoticeAlert key={answers} notice={notice} />}
      {content}
    </>
  );
}

function AcceptInvitationContent({ link }: { link: InvitationLink | undefined }) {
  const { t } = useTranslation('auth');
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('acceptInvitation.title')}</h1>
      {link === undefined ? <InvalidLinkAlert /> : <InvitationFlow link={link} />}
    </main>
  );
}

/**
 * The `/accept-invitation` page. The fragment is taken here, outside the `Suspense`
 * boundary of the on-demand `auth` namespace, so a suspended render cannot drop it.
 */
export function AcceptInvitationPage(): React.JSX.Element {
  const [link] = useState(takeInvitationLink);
  return (
    <Suspense fallback={null}>
      <AcceptInvitationContent link={link} />
    </Suspense>
  );
}
