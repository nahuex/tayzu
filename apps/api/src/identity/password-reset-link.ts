/**
 * Password reset link builder (044 task 3.5, design D3 "Link" and D14). The
 * origin comes only from the trusted `PASSWORD_RESET_LINK_BASE_URL` setting:
 * the builder takes no request, header or `BETTER_AUTH_URL` input. The path is
 * fixed and the id and token travel in the fragment, which browsers never send
 * to a server.
 */
const RESET_PASSWORD_PATH = '/reset-password';

export function buildPasswordResetLink(input: {
  readonly baseUrl: string;
  readonly resetId: string;
  readonly token: string;
}): string {
  const { origin } = new URL(input.baseUrl);
  const fragment = new URLSearchParams({
    reset: input.resetId,
    token: input.token,
  }).toString();
  return `${origin}${RESET_PASSWORD_PATH}#${fragment}`;
}
