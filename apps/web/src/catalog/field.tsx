/** A description-list entry shared by the entity page's header and Details tab. */
import type { ReactNode } from 'react';

/** One `<dt>` and its `<dd>`, kept adjacent inside a grouping `<div>`. */
export function Field(props: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="break-words">{props.children}</dd>
    </div>
  );
}
