/**
 * A labelled input of the authentication pages (design D16 and Q71), with its error tied
 * to it (`aria-invalid`, `aria-describedby`), so the error is its accessible description.
 */
import { useId, type ComponentProps } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Field({
  label,
  error,
  ...inputProps
}: { label: string; error: string | undefined } & ComponentProps<typeof Input>) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        {...inputProps}
      />
      {error !== undefined && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
