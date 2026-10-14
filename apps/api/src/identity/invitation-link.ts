/**
 * Invitation link builder (043 task 6.3, design D5, Resolved decision Q32).
 * The origin comes only from the trusted `INVITATION_LINK_BASE_URL` setting:
 * the builder takes no request, header or `BETTER_AUTH_URL` input. The path is
 * fixed and the id and token travel in the fragment, which browsers never send
 * to a server.
 */
const ACCEPT_INVITATION_PATH = '/accept-invitation';

export function buildInvitationLink(input: {
  readonly baseUrl: string;
  readonly invitationId: string;
  readonly token: string;
}): string {
  const { origin } = new URL(input.baseUrl);
  const fragment = new URLSearchParams({
    invitation: input.invitationId,
    token: input.token,
  }).toString();
  return `${origin}${ACCEPT_INVITATION_PATH}#${fragment}`;
}
