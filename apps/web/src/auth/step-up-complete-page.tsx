/**
 * The Visma Connect step-up completion page, `/step-up/complete` (design D11, D12, D15
 * and Q14, Q68, Q76). The re-authorization callback redirects here, with `?result=failed`
 * or `?result=rate_limited` when it did not complete.
 *
 * The page is public: it never reads the session and sends no request. On mount it reads
 * the stored return path once and deletes it (`./step-up-return.js`), `/` when missing or
 * invalid. With no `result` it replaces itself with that path at once, raising the
 * in-memory notice the shell shows there ("you are back, repeat the action"). On a
 * failure it stays, with an alert and a "Go back" link to the path. It never says
 * "verified", since the next request may still ask for a step-up, and it never repeats
 * the action: the user does.
 */
import { useRouter, useSearch } from '@tanstack/react-router';
import { Suspense, useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert } from '@/components/ui/alert';

import { STEP_UP_RESULTS } from '../app/search-params.js';
import { useStepUpStore } from '../state/step-up.js';

import { searchField } from './route-search.js';
import { takeStepUpReturnPath } from './step-up-return.js';

type Failure = (typeof STEP_UP_RESULTS)[number];

/** The route's validated `result`, read again as `unknown`; anything else is absent. */
function failureOf(search: unknown): Failure | undefined {
  const result = searchField(search, 'result');
  return STEP_UP_RESULTS.find((value) => value === result);
}

/** A plain left click, which the router handles; any other click keeps the link's default. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function FailureContent({
  failure,
  returnPath,
}: {
  failure: Failure;
  returnPath: string;
}): React.JSX.Element {
  const { t } = useTranslation('auth');
  const router = useRouter();
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('stepUpComplete.title')}</h1>
      <Alert variant="destructive">
        {t(failure === 'failed' ? 'stepUpComplete.failed' : 'stepUpComplete.rateLimited')}
      </Alert>
      <a
        href={returnPath}
        className="underline underline-offset-4"
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          router.history.replace(returnPath);
        }}
      >
        {t('stepUpComplete.back')}
      </a>
    </main>
  );
}

/**
 * The `/step-up/complete` page. The stored path is taken here, outside the `auth`
 * boundary: a render that suspends while the namespace loads would lose it.
 */
export function StepUpCompletePage(): React.JSX.Element | null {
  const search: unknown = useSearch({ from: '/step-up/complete' });
  const failure = failureOf(search);
  const router = useRouter();
  const [returnPath] = useState(takeStepUpReturnPath);

  useEffect(() => {
    if (failure !== undefined) return;
    useStepUpStore.getState().raiseReturnNotice();
    router.history.replace(returnPath);
  }, [failure, returnPath, router]);

  if (failure === undefined) return null;
  return (
    <Suspense fallback={null}>
      <FailureContent failure={failure} returnPath={returnPath} />
    </Suspense>
  );
}
