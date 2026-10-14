# Secrets

Design D15 of `openspec/changes/002-auth-and-rbac/design.md`. Secrets come
only from the environment. In every deployed environment they are Azure Key
Vault secrets, referenced natively by Azure Container Apps and resolved into
environment variables at container start. Locally and in tests they come from
`.env` (git-ignored) or the shell. The application uses no Key Vault SDK.

`apps/api/src/config.ts` (`loadConfig`) validates them at startup. The
process refuses to start when a required value is missing, blank or
malformed. The error names the variable and never contains a value. Better Auth's own logger is silenced and the span exporter drops the URL query, so a secret or token in a query string is never written or exported (Q67). No secret
is ever logged, traced or returned in an error response. The algorithms that
use these secrets are in the [Cryptographic inventory](crypto-inventory.md).

## Inventory

Everything `apps/api` reads from the environment (the variables that only the
maintenance scripts read are in [Maintenance jobs](#maintenance-jobs-and-the-bootstrap-cli)). "Secret" means the value
must live in Key Vault; "Sensitive" means it is not a credential but reveals
topology or trust configuration, so it is still never logged or echoed.

| Variable                                                                                         | Class     | Purpose                                                                                                                                                                                             | Validation                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                   | Secret    | Runtime pool as `tayzu_app` (password inside). Also what `db:migrate` reads today. Outside test, startup refuses a role that is a superuser, has `BYPASSRLS` or owns a `catalog_*` table.           | Required, non-blank. `sslmode=verify-full` outside the test harness (`createPool`).                                                |
| `AUTH_DATABASE_URL`                                                                              | Secret    | Better Auth pool as `tayzu_auth`. Never falls back to `DATABASE_URL`. Same startup role assertion as `DATABASE_URL`.                                                                                | Required, non-blank. `sslmode=verify-full` outside the test harness.                                                               |
| `BETTER_AUTH_SECRET`                                                                             | Secret    | Better Auth's one secret: cookie signing and the encryption key for the data below.                                                                                                                 | Required, at least 32 characters.                                                                                                  |
| `VISMA_CONNECT_CLIENT_SECRET`                                                                    | Secret    | OAuth client secret for Visma Connect.                                                                                                                                                              | All three `VISMA_CONNECT_*` variables or none. When any is set, each is required and non-blank.                                    |
| `ACS_CONNECTION_STRING`                                                                          | Secret    | Azure Communication Services connection string of the dedicated send-only resource for invitation and notice email (`043` design D5 and Q28). Read by `apps/api/src/config.ts` from `043` task 6.5. | Required when `EMAIL_PROVIDER` is `acs` (`043` task 6.5).                                                                          |
| `IDENTITY_TOKEN_HMAC_SECRET`                                                                     | Secret    | Key of the HMAC-SHA256 that turns a recipient email into the cap key stored in `auth.rate_limit` (`043` Q93, `apps/api/src/identity/recipient-key.ts`). Read by `apps/api/src/config.ts`.           | Required outside `NODE_ENV=test`: a deployed environment without it fails startup. At least 32 bytes. Never printed.               |
| `OTEL_EXPORTER_OTLP_HEADERS` and per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS`   | Secret    | Collector authentication headers, read by the OpenTelemetry exporters from the process environment, not by Tayzu code.                                                                              | Not validated by Tayzu.                                                                                                            |
| `EMAIL_PROVIDER`                                                                                 | Sensitive | Email provider: `acs` or `none` (the non-sending sender; DAST exports it). `043` task 6.5.                                                                                                          | Required outside `NODE_ENV=test`; unset fails closed.                                                                              |
| `EMAIL_SENDER_ADDRESS`                                                                           | Sensitive | Sender address of the `acs` provider.                                                                                                                                                               | Required when `EMAIL_PROVIDER` is `acs`.                                                                                           |
| `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`                                                               | Sensitive | Comma-separated recipient domains a real sender may reach (Q67, Q99).                                                                                                                               | Mandatory for a real provider under `NODE_ENV=test`; optional elsewhere.                                                           |
| `INVITATION_EMAIL_KILL_SWITCH`                                                                   | Setting   | Stops every email template, the notices included, before any cap is consumed (`043` Q15, Q53).                                                                                                      | Unset or `false` is off, `true` is on, anything else fails startup. An environment variable: flipping it needs a new app revision. |
| `EMAIL_DISABLED_TENANT_IDS`                                                                      | Sensitive | Comma-separated tenant ids (demo tenants) whose emails are suppressed and logged as `catalog.security.email_tenant_blocked` (`043` Q80).                                                            | Optional. Each entry matches the catalog's tenant-id pattern, else startup fails. Never echoed.                                    |
| `INVITATION_LINK_BASE_URL`                                                                       | Sensitive | Base URL of the accept link in an invitation email (`043` Q32).                                                                                                                                     | Required outside `NODE_ENV=test`, then `https` and one of `ALLOWED_ORIGINS`. Never echoed.                                         |
| `MOUNT_IDENTITY_ROUTES`                                                                          | Setting   | Mounts the `identity.*` routes (`043` task 14.3). Off by default.                                                                                                                                   | Unset or `false` is off, `true` is on, anything else fails startup.                                                                |
| `BETTER_AUTH_URL`                                                                                | Sensitive | Public base URL of the API (cookies, redirects).                                                                                                                                                    | Required outside test and then `https`. Optional in test.                                                                          |
| `ALLOWED_ORIGINS`                                                                                | Sensitive | Comma-separated CORS and Better Auth trusted origins. The first one also builds the SSO step-up callback URL.                                                                                       | Required. Outside test, every origin is `https` and wildcard-free. Never echoed.                                                   |
| `CERBOS_ADDRESS`                                                                                 | Sensitive | `host:port` of the Cerbos gRPC endpoint. TLS is on unless it is `localhost`, `127.0.0.1` or `[::1]`.                                                                                                | Required, non-blank.                                                                                                               |
| `VISMA_CONNECT_DISCOVERY_URL`                                                                    | Sensitive | OIDC discovery document of Visma Connect.                                                                                                                                                           | `https` outside test. Startup fails when it cannot be discovered. Never echoed.                                                    |
| `VISMA_CONNECT_CLIENT_ID`                                                                        | Sensitive | OAuth client id for Visma Connect.                                                                                                                                                                  | See `VISMA_CONNECT_CLIENT_SECRET`.                                                                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Sensitive | OTLP collector URLs.                                                                                                                                                                                | One must be set outside test, unless `TAYZU_TELEMETRY_DISABLED=true`.                                                              |
| `TAYZU_TELEMETRY_DISABLED`                                                                       | Setting   | Explicit opt-out of telemetry export (Q41). Security logging must not be silently absent.                                                                                                           | Unset or `false` is off, `true` is on, anything else fails startup.                                                                |
| `HOST`, `PORT`                                                                                   | Setting   | Listener address of `main.ts` (`HOST` defaults to `0.0.0.0`).                                                                                                                                       | `PORT` is required, an integer from 0 to 65535.                                                                                    |
| `NODE_ENV`                                                                                       | Setting   | `test` relaxes the `https` checks, the `BETTER_AUTH_URL` requirement and the telemetry requirement.                                                                                                 | Must never be `test` in a deployed environment.                                                                                    |

### Rate limits and request size

Settings, not secrets. Each one only tunes a limiter that is on by default
(Q39), and a set value must be a positive integer, else startup fails.

| Variable                                                       | Default      | What it tunes                                                        |
| -------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`        | 10 per 60 s  | Sign-in, and the same budget for the two-factor verification routes. |
| `PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS` | 10 per 60 s  | Routes that check the current password, per IP and per user.         |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`                  | 600 per 60 s | Per-principal budget on `/v1/*`.                                     |
| `TOKEN_EXCHANGE_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`          | 30 per 60 s  | `POST /v1/auth/token`, per IP.                                       |
| `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`                     | 600          | Back-channel logout, per source IP.                                  |
| `BODY_LIMIT_BYTES`                                             | 1,048,576    | Maximum request body.                                                |

### Migrations

`db:migrate` (`packages/db/src/run-migrations.ts`) reads `DATABASE_URL`, the
runtime `tayzu_app` URL, today. A separate `MIGRATION_DATABASE_URL` for the
`tayzu_migrator` role is not wired: no code reads that variable. Wiring it,
is a gate for the first deployment (Q58). Until then, do not assume the
migrator role is separate in any deployed environment.

The startup assertion that the runtime roles are not privileged is wired
(task 25.3, Q62). Outside test, `createAppFromEnv` checks `current_user` of
the `DATABASE_URL` and `AUTH_DATABASE_URL` pools and aborts with a fixed
message, naming no role, host or password, when the role is a superuser, has
`BYPASSRLS` or owns a `catalog_*` table. Because it judges the role in effect,
pointing either URL at the migrator or the bootstrap role fails startup.

The `jwt` plugin's signing key pair is generated by Better Auth and stored in
the database, with its private key encrypted with a key derived from
`BETTER_AUTH_SECRET`. Rotating that secret is therefore also how the signing
key's protection, and every other value encrypted under it, is rotated (see
below).

## Owner and rotation of the identity secrets

The owner is the team that holds the Key Vault secret and runs its rotation.
Each procedure below follows the [Change procedure](#change-procedure): a new
Key Vault version, a new app revision, then revocation of the old version.

| Secret                                                      | Owner    | Rotation                                                                              |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ACS_CONNECTION_STRING`                                     | Platform | [Communication Services connection string](#communication-services-connection-string) |
| `IDENTITY_TOKEN_HMAC_SECRET`                                | Platform | [Recipient cap key secret](#recipient-cap-key-secret)                                 |
| `AUTH_DATABASE_URL` of the jobs (the `tayzu_auth` password) | Platform | [Maintenance jobs](#maintenance-jobs-and-the-bootstrap-cli)                           |

The credential lifecycle of machine credentials (the 90-day cadence and the
immediate cutover of a rotation) is a policy, not a Key Vault secret: it is in
[Data retention and identity runbooks](data-retention.md#credential-rotation-cadence)
and [ADR-0018](../adr/0018-credential-rotation-immediate-cutover.md).

### Communication Services connection string

`ACS_CONNECTION_STRING` is the connection string of a **dedicated send-only**
Azure Communication Services resource that serves only the invitation and notice
email (`043` design D5 and Q28). The resource is restricted to the verified
sender domain, so a leaked string cannot send as another domain, but it can
still send as this one. A managed identity instead of a connection string is a
first-deployment gate (Q28). Only `apps/api` reads it, and only when
`EMAIL_PROVIDER` is `acs`.

Change procedure:

1. Create the new key on the ACS resource and a new version of the Key Vault
   secret with the new connection string.
2. Start a new app revision so the new value is resolved. If the string is
   missing the revision fails to start and the previous revision keeps serving.
3. Once the new revision is healthy, regenerate the old key on the ACS resource,
   which revokes it.

Suspected exposure is handled the same way, immediately. While it is handled,
flip the [kill switch](#email-controls) if mail must stop at once.

### Recipient cap key secret

`IDENTITY_TOKEN_HMAC_SECRET` keys the HMAC-SHA256 of the canonical recipient
email (Resolved decision Q93). The digest is what the per-recipient caps store
in `auth.rate_limit`, so a stolen table is not a list of recomputable email
digests. The algorithm is in the [Cryptographic inventory](crypto-inventory.md).
The secret is generated with at least 32 random bytes
(`openssl rand -base64 48`), never chosen by a person.

Rotation uses the [Change procedure](#change-procedure). A rotation changes
every cap key, so **the recipient buckets reset**: for each recipient the
`invitation_recipient` and `notice_recipient` counters start empty, and a
recipient may receive up to the cap again. That is accepted, and nothing else is
encrypted or signed under this secret, so no data needs re-encrypting. Do not
rotate it in the middle of an email incident; flip the kill switch first.

### Email controls

`INVITATION_EMAIL_KILL_SWITCH`, `EMAIL_PROVIDER`,
`EMAIL_RECIPIENT_DOMAIN_ALLOWLIST` and `EMAIL_DISABLED_TENANT_IDS` are
configuration, not credentials, and none of them is read at runtime after
startup, so **changing any of them needs a new app revision**. The policy behind
them is in [Data retention and identity runbooks](data-retention.md#email-policy).

- `EMAIL_PROVIDER` is `acs` or `none`. A deployed environment sets it
  explicitly; an unset value fails startup (Resolved decision Q96).
- `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST` lists the recipient domains a real sender
  may reach (Resolved decisions Q67 and Q99).
- `EMAIL_DISABLED_TENANT_IDS` lists the demo tenants whose emails are suppressed
  (Resolved decision Q80). The demo-tenant runbook adds each tenant to it.

**Emergency flip of the kill switch.** To stop every invitation and notice
email:

1. Set `INVITATION_EMAIL_KILL_SWITCH=true` in a new app revision, through the
   deployment pipeline, not by editing the running revision.
2. Confirm the new revision is healthy and serves the traffic. Until it does,
   the previous revision still sends.
3. Confirm in the provider's records that no further messages are sent.
4. To resume, deploy a revision with the variable unset or `false`, once the
   cause is resolved.

There is no runtime toggle; a persistent per-tenant setting is a recorded ticket
(design, "Persistent per-tenant email-disable list").

## Maintenance jobs and the bootstrap CLI

The `_user` blueprint backfill and the `_user` reconcile are operator-started
Container Apps Jobs (design D9). Each has **its own identity** and its own Key
Vault references (Resolved decision Q49), and neither is started by anything
else until `045` adds the reviewed workflow. The bootstrap CLI is not a job: an
operator runs it out of band, once per environment, as `002` designed it
(Resolved decision Q91), under just-in-time access (Azure PIM) with a personal
account and a named second approver. The runbooks are in
[Data retention and identity runbooks](data-retention.md).

The scripts do not use `loadConfig`. They read only the variables they declare in
`apps/api/scripts/script-config.ts`, and a missing or malformed one throws an
error that names the variable and never a value.

| Variable             | Backfill | Reconcile | Bootstrap CLI | Class     | Owner                           |
| -------------------- | -------- | --------- | ------------- | --------- | ------------------------------- |
| `DATABASE_URL`       | Yes      | Yes       | Yes           | Secret    | Platform                        |
| `AUTH_DATABASE_URL`  | Yes      | Yes       | Yes           | Secret    | Platform                        |
| `CERBOS_ADDRESS`     | Yes      | Yes       | Yes           | Sensitive | Platform                        |
| `TAYZU_OPERATOR_ID`  | No       | Yes       | Yes           | Sensitive | The operator who starts the run |
| `BETTER_AUTH_SECRET` | **No**   | **No**    | Yes           | Secret    | Platform                        |

- **`AUTH_DATABASE_URL`** is the `tayzu_auth` secret. Each script asserts its
  database roles at start through `runScript` and refuses to run as a role it
  did not declare. Rotating the `tayzu_auth` password is the
  [Change procedure](#change-procedure) step 2, and the new URL must reach the
  app, both jobs and the bootstrap CLI's environment before the old password is
  revoked. A job resolves it when an execution starts, so a rotation affects the
  next run, not one in progress.
- **`CERBOS_ADDRESS`** points each job at **its own Cerbos sidecar** on the
  loopback link of `002` Q8 (TLS is on for any other address), with the same
  policy bundle and configuration as the `apps/api` revision's (design D9).
  Whether a job execution completes while its sidecar keeps running is verified
  with `010` before the first deployment.
- **Neither job holds `BETTER_AUTH_SECRET`.** The reconcile's shed is
  parameterized SQL on its `tayzu_auth` pool and builds no Better Auth instance
  (Resolved decision Q114), so it cannot sign a session cookie or decrypt the
  `jwt` key. Only the app and the out-of-band bootstrap CLI hold it.
- **`TAYZU_OPERATOR_ID`** is an opaque id, 1 to 128 of `A-Z a-z 0-9 _ . : -`,
  never an email (Resolved decision Q116). The operator who starts the run sets
  it, until `045`'s workflow sets it from the workflow's authenticated actor. It
  is not authenticated and not a secret: the PIM record and the second approver
  are the control. It is recorded as `tayzu.identity.operator.id`. It has no
  rotation; it identifies a run.
- **Telemetry.** Every script starts telemetry and flushes it before it exits
  (Resolved decision Q79). It reads the names the app reads:
  `OTEL_EXPORTER_OTLP_ENDPOINT` (and the per-signal variants), the headers
  variables of the inventory above, and `TAYZU_TELEMETRY_DISABLED`. Outside test,
  a script refuses to run without an endpoint unless
  `TAYZU_TELEMETRY_DISABLED=true`, so an audit event is never silently dropped.

## Change procedure

Rotation procedure, the same for every secret:

1. Create a new version of the secret in Key Vault. Never edit a value in the
   Container Apps configuration directly.
2. For a database role password, first `ALTER ROLE ... PASSWORD` on the server
   (using an administrative role), then update the Key Vault secret and the
   URL that embeds it (`DATABASE_URL` or `AUTH_DATABASE_URL`).
3. For `BETTER_AUTH_SECRET`, generate at least 32 random characters
   (`openssl rand -base64 48`). Rotating it invalidates existing sessions and
   makes the encrypted TOTP secrets, backup codes, OAuth tokens and `jwt`
   private keys unreadable, so they must be re-encrypted or regenerated first.
   Schedule it and announce it. Adopting Better Auth's versioned `secrets`
   array is a recorded residual risk.
4. For `VISMA_CONNECT_CLIENT_SECRET`, rotate it at Visma Connect first, then
   in Key Vault.
5. Restart the Container App revision so the new value is resolved. If the
   value is missing or malformed the revision fails to start (fail fast), and
   the previous revision keeps serving.
6. Revoke the old secret version once the new revision is healthy.

Never paste a secret into chat, an issue, a log or a commit.
