/**
 * The entry point (design D1, D4, D10 and D12): it hands the style nonce to `get-nonce`,
 * creates the query client, the API and auth clients, the theme store, i18n and the
 * router (with the session gate and the shell), and renders them with their providers.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserHistory } from '@tanstack/react-router';
import { setNonce } from 'get-nonce';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { createAuthClient } from './api/auth-client.js';
import { createApiClient } from './api/client.js';
import { createQueryClient } from './api/query-client.js';
import { createAppRouter } from './app/router.js';
import { createI18n } from './i18n/i18n.js';
import { createThemeStore } from './state/theme.js';
import './index.css';

/**
 * D10, Q15: the API fills the `tayzu-style-nonce` meta per response; the Radix scroll
 * lock reads it through `get-nonce` for the `<style>` element it inserts.
 */
function applyStyleNonce(): void {
  const meta = document.querySelector('meta[name="tayzu-style-nonce"]');
  const nonce = meta?.getAttribute('content') ?? '';
  if (nonce !== '') setNonce(nonce);
}

async function start(rootElement: HTMLElement): Promise<void> {
  applyStyleNonce();
  const queryClient = createQueryClient();
  const apiClient = createApiClient();
  const authClient = createAuthClient();
  const themeStore = createThemeStore();
  const i18n = await createI18n();
  const router = createAppRouter({
    history: createBrowserHistory(),
    session: { authClient, queryClient },
    shell: { apiClient, authClient, themeStore },
  });

  createRoot(rootElement).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('The #root element is missing from index.html');
}
void start(rootElement);
