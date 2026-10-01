# Visma Connect references

## Purpose

Visma Connect is Tayzu's own, single primary identity provider for human
sign-in (`openspec/project.md` §23, decision D11; `002-auth-and-rbac`'s
`design.md` D22-D26). This file summarizes, in Tayzu's own words, exactly
what `002`'s implementation relies on from Visma Connect's own
documentation, so a reader does not have to re-derive it from the source
pages. It is not a copy of those pages, and it is not itself a design
decision — Tayzu's decisions live in `openspec/project.md`, the ADRs under
`docs/adr/` (`0021-visma-connect-as-primary-idp.md`), and `002`'s
`design.md`, which this file supports.

Each section below cites its source page under
`https://docs.connect.visma.com/docs/<slug>`.

## Server-side web application flow

Source: <https://docs.connect.visma.com/docs/server-side-web-applications>

Authorization code grant with PKCE (S256): redirect to
`/connect/authorize` with `client_id`, `scope` (`openid email profile`),
`redirect_uri`, `code_challenge`/`code_challenge_method`, `response_type`,
`state`, and `response_mode`. Visma recommends `response_mode=form_post`
over a query-string response. The callback exchanges `code` (+
`code_verifier`) at `/connect/token` for `access_token`/`id_token`.
Tayzu uses this exactly as documented, through Better Auth's `genericOAuth`
plugin (`002` design D23) — no custom OAuth client code.

## ID token claims

Source: <https://docs.connect.visma.com/docs/id-token>

- `sub`: Visma Connect's immutable UserID. Tayzu's account-linking key
  (`002` D24) — never `sub_external_id`, never email.
- `sid`: the IdP session id. Tayzu persists this on the Better Auth
  `session` row (`ssoSid`, `002` D25/D26) to match a later back-channel
  logout event.
- `auth_time`, `acr`, `amr`: used by `002`'s SSO step-up guard (D25) to
  independently verify a re-authorization actually happened at the
  claimed freshness and strength, since the request parameters that
  triggered it can be stripped in transit.
- `amr` accepted-MFA-method list Tayzu treats as satisfying step-up: `otp`,
  `push`, `pop`, `hwk`, `face_fpt`, `sms`, `mfa`, `pwdless`, and the
  electronic-ID methods (`nbid`, `nbid-biometric`, `sbid`, `sbid-mobile`,
  `mitid`, `mitid-erhverv`, `mitid:*`, `fbid`, `fbid:method:*`).
- `acr_values=urn:idp:vismaconnect:mfa` is the value Tayzu's step-up guard
  sends to request a fresh 2FA re-authorization (ACR >= 3, this page's own
  Level-of-Assurance table).

## UserID and email for a Connect account

Source: <https://docs.connect.visma.com/docs/userid-and-email-for-a-connect-account>

States explicitly that `sub` is immutable and unique, while email can
change and be reassigned to a different account over time, and warns that
matching on email "may lead to unauthorized access to the wrong account."
This is the reason `002` D24 forbids email-keyed linking or matching
outright, and treats email as JIT-refreshed display data only (via
`/connect/userinfo`, never as an identity key, and never written to Better
Auth's own `user.email` column, which doubles as the local sign-in
identifier).

## Re-authentication and step-up authentication

Source: <https://docs.connect.visma.com/docs/re-authentication-and-step-up-authentication>

Step-up is implemented by calling `/connect/authorize` again with
`max_age` (seconds since the required authentication/step-up, 0 meaning
"always re-authenticate") and `acr_values`. The page's own explicit
warning — "the Step-Up mechanism can be subverted by the end-user simply
stripping the parameters" — is why `002` D25 never trusts that the
redirect happened and instead validates the _returned_ `auth_time`/`acr`/
`amr` claims server-side. `002` fixes `max_age=300` (5 minutes), matching
the same freshness threshold the spec already uses for local TOTP step-up.

## Single Sign Out

Source: <https://docs.connect.visma.com/docs/single-sign-out>

Documents both Back-Channel and Front-Channel logout, and states
"Implementation of Back-channel logout is recommended" — the reason `002`
D26 builds only the back-channel path for Phase 1. The Logout Token
(`typ: logout+jwt`) carries `iss`, `aud`, `iat`, `exp` (300 seconds after
`iat`), `events` (the `http://schemas.openid.net/event/backchannel-logout`
member), `sub`, `sid`, and `jti`. `002`'s back-channel logout endpoint
validates every one of these fields, matches sessions by `sid` and/or
`sub`, and treats `jti` as the replay-protection key (reusing Better
Auth's own `verification` table rather than adding a new one).

## Session management

Source: <https://docs.connect.visma.com/docs/session-management>

The Visma Connect IdP session has a **fixed 10-hour maximum lifetime**,
independent of activity, and Tayzu's own application session lifetime is
managed separately (Better Auth's 7-day rolling / 12-hour idle policy,
`002` D3, unchanged by this addition). `002` does not attempt to mirror
Visma's 10-hour IdP-session ceiling in Tayzu's own session policy — the
two are deliberately independent, and back-channel logout (D26) is the
mechanism that keeps them from drifting apart when the IdP session ends
early.

## Security considerations

Source: <https://docs.connect.visma.com/docs/security-considerations>

The canonical `state`-as-CSRF-token pattern: a secure cookie holding the
state value, compared against the value Visma Connect echoes back on
callback. Better Auth's `genericOAuth` plugin implements this internally
for a discovery-configured provider; `002` relies on that built-in
behavior rather than re-implementing it (design D23).

## Usage of state for redirects

Source: <https://docs.connect.visma.com/docs/usage-of-state-for-redirects>

`redirect_uri` is a fixed OAuth callback, not a place to encode where the
user should land afterward — `state` is the mechanism for that, generated
as a nonce, stored locally (cookie/session), and validated on return
before trusting the callback. `002` does not add a custom post-login
redirect scheme in this change (no UI ships in `002` — Non-Goals); this
page is recorded here for `003-catalog-ui-core`, which will build the
login screen and needs this exact pattern.

## UserInfo endpoint

Source: <https://docs.connect.visma.com/docs/userinfo-endpoint>

`GET /connect/userinfo` with `Authorization: Bearer <access_token>`
returns `sub`, `name`, `given_name`, `family_name`, `email`,
`email_verified`, and more depending on the requested scopes. `002` calls
this on every successful sign-in for the JIT display-data refresh (D24),
requesting only `openid email profile` — the minimum needed for `name`/
`email`, no `groups`, `roles`, `tenants`, or other Visma-application
-specific claims Tayzu has no use for.

## Token revocation

Source: <https://docs.connect.visma.com/docs/token-revocation>

`POST /connect/revocation` revokes a **refresh token**; explicitly states
an access token itself cannot be revoked this way. `002` requests no
`offline_access` scope and therefore never holds a Visma Connect refresh
token to revoke (design D23) — session termination on the Tayzu side is
handled entirely by Tayzu's own session revocation (D3) and by back
-channel logout (D26), not by calling this endpoint.
