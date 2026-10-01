# ADR-0021: Visma Connect is the primary identity provider for humans

- **Status**: Accepted
- **Date**: 2026-09-29
- **Change**: [`002-auth-and-rbac`](../../openspec/changes/002-auth-and-rbac/design.md) (design D22-D26; Resolved decisions Q16-Q21, Q29, Q32)

Numbers `0017` to `0020` are reserved for `043-identity-lifecycle-and-org-admin`,
so this is the next free number.

## Context

`openspec/project.md` §23 (decision D11) makes Visma Connect Tayzu's single
primary human identity provider, and moves that decision into the
load-bearing auth change instead of waiting for
`025-sso-and-identity-federation`. `025` keeps per-organization SSO:
customer-brought SAML or OIDC, enforcement, group sync and SCIM. Visma Connect
is Tayzu's own IdP for every tenant and is not a customer-configurable
federation.

Local email and password stays available. The risks a second sign-in method
brings are account takeover through email matching, sessions that outlive the
IdP session, a step-up that the browser can strip, and a public logout
endpoint. What Tayzu relies on from Visma's documentation is summarized in
[`docs/references/visma-connect/README.md`](../references/visma-connect/README.md).

## Decision

1. **No public sign-up (D22).** `emailAndPassword.disableSignUp` is `true`,
   `/sign-up/email` is not on the route allowlist (it answers `404`), and
   Better Auth's `admin` routes are not reachable either. Users are created
   only by the Cerbos-gated `identity.users.create` procedure, or by the
   out-of-band bootstrap script for an organization's first admin. Both call
   `auth.api.createUser` in-process and set a system-generated password,
   returned once and never emailed.

2. **Sign-in through Better Auth's `genericOAuth` (D23).** Provider id
   `visma-connect`, discovery-based (issuer, endpoints and JWKS are read from
   the discovery document), authorization code with PKCE S256, `state` and
   `nonce` on, `requireIdTokenVerification: true`, scopes `openid email
profile` and no `offline_access`. `disableImplicitSignUp` and
   `disableSignUp` are both `true`, so SSO never creates a user.
   `overrideUserInfo` stays `false`. No new dependency. The client secret
   comes from the environment (Key Vault in a deployed environment).

3. **Linking is explicit and keyed on `sub`, never on email (D24).** There
   are two paths: a signed-in user calls `/link-social` (a Fastify
   pre-handler requires a fresh MFA verification when the caller has an
   enrolled factor), or an admin runs `identity.users.linkSsoAccount`. Both
   write an `auth.account` row with `provider_id = 'visma-connect'` and
   `account_id = sub`. A unique constraint on
   `(provider_id, account_id)` (Q29) means one Visma Connect account maps to
   one Tayzu user, and a concurrent duplicate link is rejected with a generic
   error. Unlinking, by the user (`/unlink-account`) or by an admin
   (`identity.users.unlinkSsoAccount`), is refused if it would leave the
   user with no sign-in method.

4. **Every failed SSO callback is the same `401 AUTH_SSO_REJECTED`.** An
   unlinked `sub`, a `state` mismatch and an invalid ID token cannot be told
   apart by the caller. The cause is recorded only as
   `tayzu.auth.failure_reason` on `auth.security.sso_sign_in_failed`.

5. **Display data is refreshed, identity is not (D24).** After a successful
   sign-in the handler reads `/connect/userinfo` and writes the name and
   email to the `_user` entity's display fields through the `system` actor.
   It never writes Better Auth's `user.email`, which is also the local
   sign-in identifier. A failed userinfo call does not block sign-in.

6. **Step-up for an SSO session is delegated to Visma Connect (D25).** A new
   nullable `auth.session.sso_sid` column holds the ID token's `sid` for
   sessions Visma Connect established, and is `NULL` for local sessions.
   For a session with `sso_sid` set, the guard requests a fresh
   re-authorization (`max_age=300`, `prompt=login`,
   `acr_values=urn:idp:vismaconnect:mfa`) and then validates the returned ID
   token itself: `auth_time` within 300 seconds (plus or minus 30 seconds of
   skew), `acr` of at least 3, and an `amr` from the accepted MFA list. The
   request parameters are never trusted, because the browser can strip
   them. Any failure is `AUTH_STEP_UP_REQUIRED`. Local sessions keep the
   local TOTP check.

7. **Back-channel logout is public and validated by construction (D26).**
   `POST /v1/auth/visma-connect/backchannel-logout` takes one form field,
   `logout_token`. Checks fail closed in order: signature against the
   discovered JWKS, `typ` of `logout+jwt`, `iss` and `aud`, `iat` and `exp`
   with 30 seconds of skew, the back-channel `events` member, no `nonce`, and
   a `jti` replay check. Replay state is one row per accepted token in Better
   Auth's existing `auth.verification` table, so no new table exists. Sessions
   are revoked by `sid`, or by the linked user's SSO sessions when only `sub`
   is present. Local sessions are never revoked by this endpoint. Every
   well-formed request answers `200` whatever the outcome, and only a body
   with no `logout_token` gets `400`. The route is rate-limited per source
   IP.

8. **Telemetry carries no identity.** `auth.sso.callback` and
   `auth.backchannel_logout.received` spans, `tayzu.auth.sso.events`,
   `tayzu.auth.account_link.events` and
   `tayzu.auth.backchannel_logout.events` counters, and the
   `auth.security.*` events for SSO failure, link, unlink, insufficient
   step-up and logout receipt use closed enums only. The Visma Connect `sub`,
   `sid`, tokens, email and IP never appear on any of them.

## Alternatives considered

- **`@better-auth/sso` or a hand-written OIDC client.** Rejected:
  `genericOAuth` is bundled, source-verified for this exact provider shape,
  and adds no dependency.
- **Email-assisted linking or auto-linking on a matching email.** Rejected
  outright. Visma documents that an email can change and be reassigned to
  another person, and that matching on it "may lead to unauthorized access to
  the wrong account".
- **Let Better Auth's `overrideUserInfo` refresh the email.** Rejected: it
  would overwrite the local sign-in identifier, and a reassigned or colliding
  address could change or collide with a local identity.
- **Require a local TOTP for every user so step-up is always local.**
  Rejected: it defeats SSO, and Visma Connect's MFA is a stronger, separately
  audited control.
- **Front-channel logout.** Rejected for now: Visma recommends the
  back-channel form, and 002 ships no UI for an iframe to live in.
- **A dedicated table for `jti` replay state.** Rejected: `auth.verification`
  already exists, is generic, tenant-independent and under the approved
  grants.
- **Keep public self sign-up open, gated by an invitation token.** Rejected:
  the invitation lifecycle is `043`'s, and a partial version would drift from
  it.

## Consequences

- Two sign-in methods coexist and never merge. Signing out of Visma Connect
  revokes only the sessions Visma Connect established.
- `sso_sid` is one column with two consumers: the step-up guard and the
  back-channel logout join. It is a Checkpoint 3 migration
  (`0010_auth_session_sso_sid`), which also adds the `account` unique
  constraint (Q29).
- Visma Connect's discovery, JWKS and userinfo endpoints become dependencies
  on its uptime. A discovery or JWKS failure at registration must fail the
  readiness probe rather than start degraded.
- Unlinking an account does not revoke its existing sessions. Only
  back-channel logout and the ordinary session policy (7 days, 12-hour idle)
  end them. This is accepted because the natural expiry is short.
- The Visma Developer Portal client (redirect URI, post-logout redirect URI,
  back-channel logout URI) is registered out of band before the first deploy.
- **Implementation state at the time of writing.** Where the code differs
  from design D23-D26, the code is authoritative:
  - The back-channel rate limit is a fixed 600 requests per minute per IP.
    The `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE` variable of Q32 is not
    read anywhere yet.
  - `createAppFromEnv` (`apps/api/src/bootstrap.ts`) does not pass the `sso`
    option, so the process entry point does not register Visma Connect. With
    no SSO configuration, the back-channel route still exists and answers
    `200` for a well-formed request without processing it.
  - The step-up guard (`createStepUpGuard`) is exported but not yet applied
    to the `x-tayzu-risk: high` routes in `apps/api/src/server.ts`. Only the
    `/link-social` pre-handler enforces step-up over HTTP today.

  See [`docs/security/attack-surfaces.md`](../security/attack-surfaces.md).
