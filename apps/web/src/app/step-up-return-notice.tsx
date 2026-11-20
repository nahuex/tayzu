/**
 * The notice of the Visma Connect step-up return (design D11, Step-up dialog, and Q76):
 * "you are back, repeat the action", in a status region of the shell. `/step-up/complete`
 * raises it in the step-up store, in memory only; the shell that mounts at the stored
 * path takes it, so it shows once, and hides it as soon as the location changes.
 */
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useStepUpStore } from '../state/step-up.js';

export function StepUpReturnNotice(): React.JSX.Element | null {
  const { t } = useTranslation('common');
  const href = useRouterState({ select: (state) => state.location.href });
  const [notice, setNotice] = useState(() => ({
    visible: useStepUpStore.getState().returnNotice,
    at: href,
  }));

  // Taken: a later mount of the shell does not show it again.
  useEffect(() => {
    if (notice.visible) useStepUpStore.getState().clearReturnNotice();
  }, [notice.visible]);

  // Shown only where the user came back to.
  if (notice.visible && href !== notice.at) setNotice({ visible: false, at: href });

  if (!notice.visible || href !== notice.at) return null;
  return (
    <p role="status" className="border-b px-4 py-2 text-sm">
      {t('stepUpNotice.returned')}
    </p>
  );
}
