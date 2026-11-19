/**
 * Smoke test of the web app's Vitest setup (task 2.4, design D2 and D16).
 *
 * Assumed API of `./app.js`:
 *
 * ```ts
 * export function App(): React.JSX.Element; // renders a <main> landmark
 * ```
 *
 * `main.tsx` renders `<App />` inside `<StrictMode>` into `#root`.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './app.js';

describe('web app root', () => {
  it('renders the app root with a main landmark', () => {
    render(<App />);

    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
