/**
 * Entity delete, from the entity page (design D11, D13, D16 and Q12, Q75, Q88).
 *
 * "Delete entity" is offered to every user: the server decides, and a refusal is an
 * alert. It opens a confirmation dialog with the `detachReferences` option, unchecked by
 * default. Confirm runs `entities.delete` through `withStepUp`, so a `step_up_required`
 * answer opens the shell's `StepUpDialog` over this one and retries once after a
 * verification, with the same choice. The dialog stays open while the call is pending.
 *
 * - `204`: the entity lists are invalidated, the dialog closes and the app returns to
 *   the blueprint's table.
 * - `reference_violation`: one alert with the readable referrers, as plain text in the
 *   server's order (bare identifiers, possibly of other blueprints, so no link is
 *   guessed), and "+N not visible" only when N is above 0. Checking the option and
 *   confirming again retries.
 * - A cancelled step-up shows nothing; an `unauthenticated` answer is the shell's (Q69).
 * - Any other failure: one alert whose text depends on the kind only, never on the
 *   server's message.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { useApiClient } from '../api/api-client-context.js';
import { toApiError, type ApiError } from '../api/errors.js';
import { withStepUp } from '../state/step-up.js';

interface EntityAddress {
  readonly blueprint: string;
  readonly entity: string;
}

/** The query key prefix of every `entities.list` query (the catalog table's). */
const ENTITY_LISTS_KEY = ['entities', 'list'] as const;

function ReferenceViolation({
  error,
}: {
  readonly error: Extract<ApiError, { kind: 'reference_violation' }>;
}): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const labelId = useId();
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-col gap-2">
        <p>{t('entity.delete.blocked')}</p>
        <p id={labelId}>{t('entity.delete.referrers')}</p>
        <ul aria-labelledby={labelId} className="list-disc pl-5 font-mono text-xs">
          {error.referrers.map((referrer, index) => (
            // Server order, and a bare identifier may repeat across blueprints: the
            // position is the key.
            <li key={index}>{referrer}</li>
          ))}
        </ul>
        {error.notVisible > 0 && (
          <p>{t('entity.delete.notVisible', { count: error.notVisible })}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** The failure's alert, or nothing for a cancelled step-up or a lost session. */
function DeleteFailure({ error }: { readonly error: ApiError }): React.JSX.Element | null {
  const { t } = useTranslation('catalog');
  switch (error.kind) {
    case 'reference_violation':
      return <ReferenceViolation error={error} />;
    case 'step_up_required':
    case 'unauthenticated':
      return null;
    case 'forbidden':
      return (
        <Alert variant="destructive">
          <AlertDescription>{t('entity.delete.error.forbidden')}</AlertDescription>
        </Alert>
      );
    default:
      return (
        <Alert variant="destructive">
          <AlertDescription>{t('entity.delete.error.server')}</AlertDescription>
        </Alert>
      );
  }
}

/** The dialog's content, mounted only while open, so every opening starts unchecked. */
function DeleteConfirmation({
  blueprint,
  entity,
  onCancel,
  onDeleted,
}: EntityAddress & {
  readonly onCancel: () => void;
  readonly onDeleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const checkboxId = useId();
  const [detachReferences, setDetachReferences] = useState(false);

  const mutation = useMutation({
    // The choice is the mutation's variable, so the step-up retry repeats it as sent.
    mutationFn: (detach: boolean) =>
      withStepUp(() =>
        apiClient.entities.delete({
          params: { blueprint, entity },
          query: detach ? { detachReferences: true } : {},
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ENTITY_LISTS_KEY });
      onDeleted();
    },
  });
  const pending = mutation.isPending;

  return (
    <DialogContent
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('entity.delete.title')}</DialogTitle>
        <DialogDescription>{t('entity.delete.description')}</DialogDescription>
      </DialogHeader>
      {mutation.error !== null && <DeleteFailure error={toApiError(mutation.error)} />}
      <div className="flex items-center gap-2">
        <input
          id={checkboxId}
          type="checkbox"
          className="size-4 accent-primary"
          checked={detachReferences}
          disabled={pending}
          onChange={(event) => {
            setDetachReferences(event.target.checked);
          }}
        />
        <label htmlFor={checkboxId}>{t('entity.delete.detachReferences')}</label>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          {t('entity.delete.cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            mutation.mutate(detachReferences);
          }}
        >
          {t('entity.delete.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** The "Delete entity" button and its confirmation dialog. */
export function EntityDelete({ blueprint, entity }: EntityAddress): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="destructive">
          {t('entity.delete.open')}
        </Button>
      </DialogTrigger>
      {open && (
        <DeleteConfirmation
          blueprint={blueprint}
          entity={entity}
          onCancel={() => {
            setOpen(false);
          }}
          onDeleted={() => {
            setOpen(false);
            void router.navigate({ to: '/catalog/$blueprint', params: { blueprint } });
          }}
        />
      )}
    </Dialog>
  );
}
