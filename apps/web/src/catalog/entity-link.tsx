/**
 * The one link to an entity page (design D13, Q18, Q36 and Q85), for the related rows
 * and search to reuse.
 *
 * An addressable identifier is a router link to `/catalog/$blueprint/$entity`, whose
 * `@`, `:` and `=` stay unencoded (D12). Any other identifier (one holding `/`, or made
 * only of dots) cannot be a route segment: it is a disabled link with no `href`,
 * described by a visible localized note, and activating it goes nowhere.
 */
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isAddressableIdentifier } from './columns.js';

export function EntityLink(props: {
  readonly blueprint: string;
  readonly identifier: string;
  /** The link text; the identifier when absent. */
  readonly children?: ReactNode;
}): React.JSX.Element {
  const { blueprint, identifier } = props;
  const label = props.children ?? identifier;
  if (isAddressableIdentifier(identifier)) {
    return (
      <Link
        to="/catalog/$blueprint/$entity"
        params={{ blueprint, entity: identifier }}
        className="underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return <DisabledEntityLink>{label}</DisabledEntityLink>;
}

function DisabledEntityLink({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation('catalog');
  const noteId = useId();
  return (
    <span className="flex flex-col">
      <span
        role="link"
        aria-disabled="true"
        aria-describedby={noteId}
        tabIndex={0}
        className="text-muted-foreground"
      >
        {children}
      </span>
      <span id={noteId} className="text-xs text-muted-foreground">
        {t('entity.notAddressable')}
      </span>
    </span>
  );
}
