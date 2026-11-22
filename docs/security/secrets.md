# Secrets

Design D15 of `openspec/changes/archive/2026-10-15-002-auth-and-rbac/design.md`. Secrets come
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

| Variable                                                                                         | Class     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                         | Validation                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                   | Secret    | Runtime pool as `tayzu_app` (password inside). Also what `db:migrate` reads today. Outside test, startup refuses a role that is a superuser, has `BYPASSRLS` or owns a `catalog_*` table.                                                                                                                                                                                                                                                       | Required, non-blank. `sslmode=verify-full` outside the test harness (`createPool`).                                                                                                                                                                                                                 |
| `AUTH_DATABASE_URL`                                                                              | Secret    | Better Auth pool as `tayzu_auth`. Never falls back to `DATABASE_URL`. Same startup role assertion as `DATABASE_URL`.                                                                                                                                                                                                                                                                                                                            | Required, non-blank. `sslmode=verify-full` outside the test harness.                                                                                                                                                                                                                                |
| `BETTER_AUTH_SECRET`                                                                             | Secret    | Better Auth's one secret: cookie signing and the encryption key for the data below.                                                                                                                                                                                                                                                                                                                                                             | Required, at least 32 characters.                                                                                                                                                                                                                                                                   |
| `VISMA_CONNECT_CLIENT_SECRET`                                                                    | Secret    | OAuth client secret for Visma Connect.                                                                                                                                                                                                                                                                                                                                                                                                          | All three `VISMA_CONNECT_*` variables or none. When any is set, each is required and non-blank.                                                                                                                                                                                                     |
| `ACS_CONNECTION_STRING`                                                                          | Secret    | Azure Communication Services connection string of the dedicated send-only resource for invitation and notice email (`043` design D5 and Q28). Read by `apps/api/src/config.ts` from `043` task 6.5.                                                                                                                                                                                                                                             | Required when `EMAIL_PROVIDER` is `acs` (`043` task 6.5).                                                                                                                                                                                                                                           |
| `IDENTITY_TOKEN_HMAC_SECRET`                                                                     | Secret    | Key of the HMAC-SHA256 that turns a recipient email into the cap key stored in `auth.rate_limit` (`043` Q93, `apps/api/src/identity/recipient-key.ts`). Read by `apps/api/src/config.ts`.                                                                                                                                                                                                                                                       | Required outside `NODE_ENV=test`: a deployed environment without it fails startup. At least 32 bytes. Never printed.                                                                                                                                                                                |
| `OTEL_EXPORTER_OTLP_HEADERS` and per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS`   | Secret    | Collector authentication headers, read by the OpenTelemetry exporters from the process environment, not by Tayzu code.                                                                                                                                                                                                                                                                                                                          | Not validated by Tayzu.                                                                                                                                                                                                                                                                             |
| `EMAIL_PROVIDER`                                                                                 | Sensitive | Email provider: `acs` or `none` (the non-sending sender; DAST exports it). `043` task 6.5.                                                                                                                                                                                                                                                                                                                                                      | Required outside `NODE_ENV=test`; unset fails closed.                                                                                                                                                                                                                                               |
| `EMAIL_SENDER_ADDRESS`                                                                           | Sensitive | Sender address of the `acs` provider.                                                                                                                                                                                                                                                                                                                                                                                                           | Required when `EMAIL_PROVIDER` is `acs`.                                                                                                                                                                                                                                                            |
| `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`                                                               | Sensitive | Comma-separated recipient domains a real sender may reach (Q67, Q99).                                                                                                                                                                                                                                                                                                                                                                           | Mandatory for a real provider under `NODE_ENV=test`; optional elsewhere.                                                                                                                                                                                                                            |
| `INVITATION_EMAIL_KILL_SWITCH`                                                                   | Setting   | Stops every email template (invitation, password reset, the five notices) in the app, and the `recover:admin-mfa` CLI's notice, before any cap is consumed (`043` Q15, Q53; `044` D9, D12). Its name says "invitation" but its scope is every email; renaming it is a breaking change, so it is a ticket.                                                                                                                                       | Unset or `false` is off, `true` is on, anything else fails startup. An environment variable: flipping it needs a new app revision.                                                                                                                                                                  |
| `EMAIL_DISABLED_TENANT_IDS`                                                                      | Sensitive | Comma-separated tenant ids (demo tenants) whose emails are suppressed and logged as `catalog.security.email_tenant_blocked` (`043` Q80).                                                                                                                                                                                                                                                                                                        | Optional. Each entry matches the catalog's tenant-id pattern, else startup fails. Never echoed.                                                                                                                                                                                                     |
| `INVITATION_LINK_BASE_URL`                                                                       | Sensitive | Base URL of the accept link in an invitation email (`043` Q32).                                                                                                                                                                                                                                                                                                                                                                                 | Required outside `NODE_ENV=test`, then `https` and one of `ALLOWED_ORIGINS`. Never echoed.                                                                                                                                                                                                          |
| `PASSWORD_RESET_LINK_BASE_URL`                                                                   | Sensitive | Base URL of the single link in a password reset email (`044` design D9). The path `/reset-password` is fixed in code.                                                                                                                                                                                                                                                                                                                           | Required outside `NODE_ENV=test`, then `https` and one of `ALLOWED_ORIGINS`; in test optional, `http` or `https`. Never echoed.                                                                                                                                                                     |
| `MOUNT_IDENTITY_ROUTES`                                                                          | Setting   | Mounts the `identity.*` routes (`043` task 14.3). Off by default.                                                                                                                                                                                                                                                                                                                                                                               | Unset or `false` is off, `true` is on, anything else fails startup.                                                                                                                                                                                                                                 |
| `ORG_DELETION_WINDOW_DAYS`                                                                       | Setting   | Days from an org-deletion request to its purge (`045` design D1, Resolved decision Q21). Configuration, not a secret.                                                                                                                                                                                                                                                                                                                           | Optional, 14 when unset. A set value must be an integer from 7 to 14, else startup fails.                                                                                                                                                                                                           |
| `WEB_DIST_DIR`                                                                                   | Setting   | Absolute path of the Vite build of `apps/web` that `apps/api` serves on its own origin (`003` design D9, Q21): the hashed assets, the root build files and the SPA fallback. A path, not a secret. Unset: no web route is registered and every other route answers as before; the security headers apply either way. With it set, the Visma Connect re-authorization callback also answers with a `303` to `/step-up/complete` instead of JSON. | Optional. When set (even empty), startup fails unless it is an absolute path to a readable directory containing an `index.html` file; the error names the variable, never its value. Startup also fails if that `index.html` lacks the style nonce placeholder or a root build file cannot be read. |
| `BETTER_AUTH_URL`                                                                                | Sensitive | Public base URL of the API (cookies, redirects).                                                                                                                                                                                                                                                                                                                                                                                                | Required outside test and then `https`. Optional in test.                                                                                                                                                                                                                                           |
| `ALLOWED_ORIGINS`                                                                                | Sensitive | Comma-separated CORS and Better Auth trusted origins. The first one also builds the SSO step-up callback URL.                                                                                                                                                                                                                                                                                                                                   | Required. Outside test, every origin is `https` and wildcard-free. Never echoed.                                                                                                                                                                                                                    |
| `CERBOS_ADDRESS`                                                                                 | Sensitive | `host:port` of the Cerbos gRPC endpoint. TLS is on unless it is `localhost`, `127.0.0.1` or `[::1]`.                                                                                                                                                                                                                                                                                                                                            | Required, non-blank.                                                                                                                                                                                                                                                                                |
| `VISMA_CONNECT_DISCOVERY_URL`                                                                    | Sensitive | OIDC discovery document of Visma Connect.                                                                                                                                                                                                                                                                                                                                                                                                       | `https` outside test. Startup fails when it cannot be discovered. Never echoed.                                                                                                                                                                                                                     |
| `VISMA_CONNECT_CLIENT_ID`                                                                        | Sensitive | OAuth client id for Visma Connect.                                                                                                                                                                                                                                                                                                                                                                                                              | See `VISMA_CONNECT_CLIENT_SECRET`.                                                                                                                                                                                                                                                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Sensitive | OTLP collector URLs.                                                                                                                                                                                                                                                                                                                                                                                                                            | One must be set outside test, unless `TAYZU_TELEMETRY_DISABLED=true`.                                                                                                                                                                                                                               |
| `TAYZU_TELEMETRY_DISABLED`                                                                       | Setting   | Explicit opt-out of telemetry export (Q41). Security logging must not be silently absent.                                                                                                                                                                                                                                                                                                                                                       | Unset or `false` is off, `true` is on, anything else fails startup.                                                                                                                                                                                                                                 |
| `HOST`, `PORT`                                                                                   | Setting   | Listener address of `main.ts` (`HOST` defaults to `0.0.0.0`).                                                                                                                                                                                                                                                                                                                                                                                   | `PORT` is required, an integer from 0 to 65535.                                                                                                                                                                                                                                                     |
| `NODE_ENV`                                                                                       | Setting   | `test` relaxes the `https` checks, the `BETTER_AUTH_URL` requirement and the telemetry requirement.                                                                                                                                                                                                                                                                                                                                             | Must never be `test` in a deployed environment.                                                                                                                                                                                                                                                     |

### Rate limits and request size

Settings, not secrets. Each one only tunes a limiter that is on by default
(Q39), and a set value must be a positive integer, else startup fails. The
`PASSWORD_RESET_*` and notice rows are `044` design D9; the Max and Window
variables of one row are both read, and a missing one takes the default.

| Variable                                                             | Default           | What it tunes                                                                                                  |
| -------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`              | 10 per 60 s       | Sign-in, and the same budget for the two-factor verification routes.                                           |
| `PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`       | 10 per 60 s       | Routes that check the current password, per IP and per user.                                                   |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`                        | 600 per 60 s      | Per-principal budget on `/v1/*`.                                                                               |
| `TOKEN_EXCHANGE_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`                | 30 per 60 s       | `POST /v1/auth/token`, per IP.                                                                                 |
| `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`                           | 600               | Back-channel logout, per source IP.                                                                            |
| `PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`        | 10 per 60 s       | Reset request route, per IP.                                                                                   |
| `PASSWORD_RESET_CONFIRM_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`        | 10 per 60 s       | Reset confirm route, per IP.                                                                                   |
| `PASSWORD_RESET_RECIPIENT_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`      | 5 per 3600 s      | Reset emails per recipient (HMAC key).                                                                         |
| `PASSWORD_RESET_IP_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`             | 10 per 3600 s     | Reset emails per normalized IP.                                                                                |
| `PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`         | 600 per 3600 s    | Reset emails across the platform.                                                                              |
| `RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS`     | 10 per 86 400 s   | The four `044` notices, per recipient, apart from the other buckets.                                           |
| `ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS` | 20 per 86 400 s   | Account-created notices per creating tenant (Q20).                                                             |
| `ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_MAX`, `..._WINDOW_SECONDS` | 1000 per 86 400 s | Account-created notices across the platform (Q20, Q28).                                                        |
| `PASSWORD_RESET_MIN_RESPONSE_MS`                                     | 400               | Minimum response time of the reset request route (the confirm route is not padded), an integer from 1 to 5000. |
| `BODY_LIMIT_BYTES`                                                   | 1,048,576         | Maximum request body.                                                                                          |

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

| Secret                                                                            | Owner    | Rotation                                                                              |
| --------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ACS_CONNECTION_STRING`                                                           | Platform | [Communication Services connection string](#communication-services-connection-string) |
| `IDENTITY_TOKEN_HMAC_SECRET`                                                      | Platform | [Recipient cap key secret](#recipient-cap-key-secret)                                 |
| `AUTH_DATABASE_URL` of the jobs and the CLIs (the `tayzu_auth` password)          | Platform | [Maintenance jobs](#maintenance-jobs-and-the-bootstrap-cli)                           |
| `PURGE_DATABASE_URL` of the purge job (the `tayzu_purge` password)                | Platform | [Org-deletion jobs](#org-deletion-jobs-purge-and-reversal)                            |
| `REVERSAL_DATABASE_URL` of the reversal job (the `tayzu_deletion_admin` password) | Platform | [Org-deletion jobs](#org-deletion-jobs-purge-and-reversal)                            |

The credential lifecycle of machine credentials (the 90-day cadence and the
immediate cutover of a rotation) is a policy, not a Key Vault secret: it is in
[Data retention and identity runbooks](data-retention.md#credential-rotation-cadence)
and [ADR-0018](../adr/0018-credential-rotation-immediate-cutover.md).

### Communication Services connection string

`ACS_CONNECTION_STRING` is the connection string of a **dedicated send-only**
Azure Communication Services resource that serves only the invitation and notice
email (`043` design D5 and Q28; the password reset email and the notices of `044`
use it too). The resource is restricted to the verified
sender domain, so a leaked string cannot send as another domain, but it can
still send as this one. A managed identity instead of a connection string is a
first-deployment gate (Q28). Two readers hold it: `apps/api`, and the
`recover:admin-mfa` CLI (`044` D12), the first script to hold a secret that can
send as the platform domain. Both read it only when `EMAIL_PROVIDER` is `acs`.

Change procedure:

1. Create the new key on the ACS resource and a new version of the Key Vault
   secret with the new connection string.
2. Start a new app revision so the new value is resolved. If the string is
   missing the revision fails to start and the previous revision keeps serving.
3. Update the operator environment's copy: the next `recover:admin-mfa` run must
   read the new version from Key Vault (see
   [Operator CLI](#operator-cli-recover-admin-mfa)). A CLI run started before
   this step still holds the old string.
4. Once the new revision is healthy and the operator environment reads the new
   version, regenerate the old key on the ACS resource, which revokes it.

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
else than the reviewed maintenance workflow of `045` (design D3), see
[OIDC federation](#oidc-federation-of-the-maintenance-workflow). `045` adds two
more jobs, the purge and the reversal, each with its own identity too, see
[Org-deletion jobs](#org-deletion-jobs-purge-and-reversal). The bootstrap CLI is not a job: an
operator runs it out of band, once per environment, as `002` designed it
(Resolved decision Q91), under just-in-time access (Azure PIM) with a personal
account and a named second approver. The runbooks are in
[Data retention and identity runbooks](data-retention.md).

The scripts do not use `loadConfig`. They read only the variables they declare in
`apps/api/scripts/script-config.ts`, and a missing or malformed one throws an
error that names the variable and never a value.

| Variable                                                        | Backfill | Reconcile | Bootstrap CLI | `recover:admin-mfa` CLI | Class     | Owner                           |
| --------------------------------------------------------------- | -------- | --------- | ------------- | ----------------------- | --------- | ------------------------------- |
| `DATABASE_URL`                                                  | Yes      | Yes       | Yes           | **No**                  | Secret    | Platform                        |
| `AUTH_DATABASE_URL`                                             | Yes      | Yes       | Yes           | Yes                     | Secret    | Platform                        |
| `CERBOS_ADDRESS`                                                | Yes      | Yes       | Yes           | **No**                  | Sensitive | Platform                        |
| `TAYZU_OPERATOR_ID`                                             | No       | Yes       | Yes           | Yes                     | Sensitive | The operator who starts the run |
| `BETTER_AUTH_SECRET`                                            | **No**   | **No**    | Yes           | **No**                  | Secret    | Platform                        |
| `IDENTITY_TOKEN_HMAC_SECRET`                                    | No       | No        | No            | **No**                  | Secret    | Platform                        |
| `EMAIL_PROVIDER`, `EMAIL_SENDER_ADDRESS`                        | No       | No        | No            | Yes                     | Sensitive | Platform                        |
| `ACS_CONNECTION_STRING`                                         | No       | No        | No            | Yes, when `acs`         | Secret    | Platform                        |
| `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`                              | No       | No        | No            | Yes, for a real sender  | Sensitive | Platform                        |
| `EMAIL_DISABLED_TENANT_IDS`, `INVITATION_EMAIL_KILL_SWITCH`     | No       | No        | No            | Optional                | Sensitive | Platform                        |
| `OTEL_EXPORTER_OTLP_*_ENDPOINT`, `OTEL_EXPORTER_OTLP_*_HEADERS` | Yes      | Yes       | Yes           | Yes, required           | Sensitive | Platform                        |
| `TAYZU_TELEMETRY_DISABLED`                                      | Yes      | Yes       | Yes           | Refused when true       | Setting   | Platform                        |

The `recover:admin-mfa` CLI also takes the argument `--approver <opaque id>`
(not an environment variable). It has no `BETTER_AUTH_SECRET` (it cannot sign a
cookie or decrypt a factor secret), no `DATABASE_URL`, no `CERBOS_ADDRESS` and
no recipient key secret: it has no cap store, so its single notice is outside
the recipient caps. A test asserts its variable list.

- **`AUTH_DATABASE_URL`** is the `tayzu_auth` secret. Each script asserts its
  database roles at start through `runScript` and refuses to run as a role it
  did not declare. Rotating the `tayzu_auth` password is the
  [Change procedure](#change-procedure) step 2, and the new URL must reach the
  app, both jobs, the bootstrap CLI's and the `recover:admin-mfa` CLI's environment before the old password is
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
  never an email (Resolved decision Q116). For the jobs the maintenance
  workflow starts, the workflow sets it from its authenticated actor, as
  `gh:<numeric GitHub actor id>` (`045` Q70), and the environment approval is
  the control. For the bootstrap CLI and `recover:admin-mfa` the operator who
  starts the run sets it; there it is not authenticated, and the PIM record and
  the second approver are the control. The backfill reads no
  `TAYZU_OPERATOR_ID`, so the workflow hands it one it ignores (`045` Q173). It
  is not a secret. It is recorded as `tayzu.identity.operator.id`. It has no
  rotation; it identifies a run.
- **Telemetry.** Every script, the two org-deletion jobs of `045` included,
  starts telemetry through `runScript`, emits its audit events and flushes them
  before it exits (Resolved decision Q79). It reads the names the app reads:
  `OTEL_EXPORTER_OTLP_ENDPOINT` (and the per-signal variants), the headers
  variables of the inventory above, and `TAYZU_TELEMETRY_DISABLED`. Outside test,
  a script refuses to run without an endpoint unless
  `TAYZU_TELEMETRY_DISABLED=true`, so an audit event is never silently dropped.
  **The `recover:admin-mfa` CLI is stricter than this shared rule** (`044` D12,
  Q29, Q31): its `main()` refuses to start, before any database or email work,
  when `TAYZU_TELEMETRY_DISABLED` is true **or** no OTLP endpoint is set,
  whatever `NODE_ENV` says. No environment variable can switch its audit event
  off in a real run.

### Operator CLI: recover-admin-mfa

`apps/api/scripts/recover-admin-mfa.ts` (package script `recover:admin-mfa`,
`044` design D12) removes the second factor of a user whom the admin reset
cannot serve: the last admin, an owner, a member of several tenants, or a factor
a squatter enrolled. It is never mounted and is not a job. It cannot reset a
password: the person uses the reset flow for that.

**Who may run it.** A platform operator, only from the production-network
operator environment, under Azure PIM just-in-time access with a personal
account. Never from a laptop, never with a shared account.

**How the operator obtains the secrets.** `AUTH_DATABASE_URL` and
`ACS_CONNECTION_STRING` are a Key Vault read under the PIM role. They are held in
the process environment of the run only. They are never typed into a shell,
never written to a file and never left in a shell history. The telemetry
variables are set the same way. The environment is discarded at the end of the
run.

**Before the run.**

1. Verify the person out of band (a video call or an employer-confirmed
   request).
2. Record a named second approver, different from the operator, and pass the
   opaque id as `--approver`. `TAYZU_OPERATOR_ID` is the operator's own opaque
   id. Neither is authenticated: the PIM record and the approver are the control.
3. Confirm that the telemetry endpoint is set. The command refuses to start
   otherwise (see the telemetry bullet above).

**The order of the recovery.** After the run the factor is gone and the password
is the only thing between the account and the next person to enrol, so the order
matters:

1. The verified person requests a password reset link **before** the run (valid
   for 30 minutes) and keeps the page open.
2. The operator runs `recover:admin-mfa` with `--organization-slug`, `--email`
   and `--approver`.
3. The person confirms the reset at once, with the link alone because no factor
   is enrolled any more. This replaces the password and ends every session.
4. The person signs in with the new password and enrols a second factor in a
   supervised session while the operator waits.
5. Only then is the account handed back, and the operator tells the person that
   the run is over.

If step 3 answers a factor request, someone enrolled in the window between steps
2 and 3: the operator repeats the run and the confirmation.

**The squatting path.** An owner who reports a reset asking for a code they never
set up has found a factor a squatter enrolled. Verify the owner out of band, then
follow the order above.

**After the run.** The command prints one line on stdout:
`mfa-reset operator=<id> approver=<id> user=<opaque user id> sessions_revoked=<n> notice=<sent|suppressed|failed>`.
The operator attaches it to the PIM record. If `notice` is `suppressed` or
`failed`, the person was not told by email and the operator tells them. A non-zero
exit after the line means the final telemetry flush failed: the reset is
committed and the audit event may be missing, so the completion line is the
record. The run is reviewed afterwards from the audit event
`catalog.audit.mfa_reset` (form `operator`), by someone other than the operator.

### Org-deletion jobs: purge and reversal

`045` (design D2 and D3, Resolved decision Q49) adds two Container Apps Jobs.
Each has **its own identity** and its own Key Vault reference, holds exactly
one database secret and asserts its own role (`current_user`) through
`runScript` at start, refusing to run as any other. No other script, no CLI and
not the app reads either URL, and none of `043`'s or `044`'s scripts holds
either role. Like every database URL here, neither is ever printed, and
`createPool` refuses one without `sslmode=verify-full` outside the test
harness. The two roles are created by migration `0013` with no password: the
password is set out of band, never in a migration.

| Variable                                                                                         | Purge job | Reversal | Class               | Owner                                                          |
| ------------------------------------------------------------------------------------------------ | --------- | -------- | ------------------- | -------------------------------------------------------------- |
| `PURGE_DATABASE_URL`                                                                             | Yes       | **No**   | Secret              | Platform                                                       |
| `REVERSAL_DATABASE_URL`                                                                          | **No**    | Yes      | Secret              | Platform                                                       |
| `TAYZU_OPERATOR_ID`                                                                              | **No**    | Yes      | Sensitive           | The maintenance workflow, from its authenticated actor         |
| `TAYZU_TENANT_ID`                                                                                | **No**    | Yes      | Sensitive           | The maintenance workflow, from its validated `tenant_id` input |
| `DATABASE_URL`, `AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET`, `CERBOS_ADDRESS`, the email variables | **No**    | **No**   | Secret or Sensitive | Platform                                                       |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (and per-signal variants), `OTEL_EXPORTER_OTLP_*_HEADERS`          | Yes       | Yes      | Sensitive           | Platform                                                       |
| `TAYZU_TELEMETRY_DISABLED`                                                                       | Yes       | Yes      | Setting             | Platform                                                       |

`TAYZU_TENANT_ID` is the reversal's input, not its configuration (Resolved
decision Q172): `cancel-org-deletion.ts` reads it directly and
`script-config.ts` does not declare it, so a missing or malformed id is
refused and logged as `invalid_tenant` rather than failing at the
configuration load. The workflow also checks it against the tenant-id pattern
before the Azure login.

- **`PURGE_DATABASE_URL`** is the `tayzu_purge` secret, held by the scheduled
  purge job alone (`identity:purge`). The role's policies admit it only to
  tenants whose deletion window has passed. Rotation: `ALTER ROLE tayzu_purge
PASSWORD` with an administrative role, then a new Key Vault version of
  `PURGE_DATABASE_URL` ([Change procedure](#change-procedure) steps 1 and 2).
  No app revision is involved: the job resolves the secret when an execution
  starts, so the rotation affects the next execution, and a run in progress
  keeps its connection. Revoke the old version once an execution on the new one
  has succeeded. A run that fails on a revoked password deletes nothing more and
  the next run resumes from the progress recorded on the marker.
- **`REVERSAL_DATABASE_URL`** is the `tayzu_deletion_admin` secret, held by the
  reversal job alone (`identity:cancel-org-deletion`). The role can only
  tombstone a pending marker whose purge has not begun. Rotation: `ALTER ROLE
tayzu_deletion_admin PASSWORD`, then a new Key Vault version of
  `REVERSAL_DATABASE_URL`, the same steps. The reversal is started only through
  the maintenance workflow, whose concurrency group runs one start at a time, so
  rotate while no reversal execution is running; the next start reads the new
  version.
- **Suspected exposure** of either is handled the same way, immediately.

### OIDC federation of the maintenance workflow

`.github/workflows/identity-maintenance.yml` (`045` design D3, Resolved
decisions Q41 and Q64) starts the reversal, the blueprint backfill and the
reconcile through OIDC, with **no stored cloud secret**. The job requests
`id-token: write`, GitHub issues a short-lived token for that run, and the
SHA-pinned `azure/login` exchanges it for an Azure token of a federated
identity. The federated credential trusts only the subject of the
`identity-maintenance` environment, in the form
`repo:<owner>/<repository>:environment:identity-maintenance`.

- **What the workflow holds.** Three environment secrets that are identifiers,
  not credentials: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
  `AZURE_SUBSCRIPTION_ID` (`045` Q173). No other `secrets.` value is
  referenced. The resource group comes from the variable
  `MAINTENANCE_RESOURCE_GROUP`, which is configuration, not a secret.
- **What the federated identity can do.** Only start the three named jobs
  (`tayzu-cancel-org-deletion`, `tayzu-backfill-user-blueprint`,
  `tayzu-reconcile-users`), see the checklist below. It holds no database
  secret: each job resolves its own Key Vault references under its own
  identity.
- **Owner and rotation.** Platform owns the federated identity. There is no
  secret to rotate. To revoke access, delete the federated credential or the
  role assignment; recreating the identity changes the three identifiers, which
  are then updated in the environment.

### GitHub settings checklist of the maintenance workflow

The workflow is only as strong as these settings, which are human-owned
(Resolved decision Q55) and are applied by the human, not by code. The
workflow's text tests (`identity-maintenance-workflow.test.ts`) cover only the
file. Each item is a first-deployment gate for `010`.

| Item         | Setting                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                              | Decision   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| 1            | Required reviewers on the `identity-maintenance` environment, with "prevent self-review"                                                                                                                                                                                                                                                                                                                                                                                            | GitHub, environment settings                       | Q55        |
| 2            | Deployment branches of the environment limited to `master`                                                                                                                                                                                                                                                                                                                                                                                                                          | GitHub, environment settings                       | Q55        |
| 3            | The OIDC federated credential's subject pinned to the `identity-maintenance` environment                                                                                                                                                                                                                                                                                                                                                                                            | Azure, federated identity                          | Q55        |
| 4            | The federated identity's Azure role limited to the action that starts the named Container Apps Jobs and scoped to those three job resources only                                                                                                                                                                                                                                                                                                                                    | Azure, role assignment                             | Q64        |
| 5            | `@nahuex` as the `CODEOWNERS` owner of `.github/workflows/**`, `.github/actions/**`, `.github/CODEOWNERS` and `apps/api/scripts/**`, with branch protection on `master` and "Require review from Code Owners", without which `CODEOWNERS` has no effect                                                                                                                                                                                                                             | GitHub, `.github/CODEOWNERS` and branch protection | Q64, Q72   |
| 6            | Administrator bypass **off** on the `identity-maintenance` environment ("Allow administrators to bypass configured protection rules" unchecked), and **no bypass actors** on the `master` ruleset or branch protection, so neither the required reviewer nor "Require review from Code Owners" can be skipped by an admin account, the sole owner's included, which is the account the agent acts with. Every pull request touching a `CODEOWNERS` path waits for the second human. | GitHub, environment and `master` ruleset           | Q179       |
| Second human | The reviewer of the environment and the second code owner is a **second human**, added before the first deployment. "Prevent self-review" leaves a single-person repository with nobody who can approve, so the workflow cannot be enabled until that person is added. Neither a bot account nor self-review stands in.                                                                                                                                                             | GitHub, environment reviewers and `CODEOWNERS`     | Q153       |
| Rehearsal    | `010`'s sandbox rehearsal confirms whether a job start can override the job's command, arguments or image, and whether `--env-vars` needs `--container-name`. If an override is possible, the human records it as an accepted risk covered by `CODEOWNERS`, the environment approval and the workflow's text tests, and a custom Azure role is a ticket. If `--env-vars` needs `--container-name`, the workflow's flag allowlist changes.                                           | `010` sandbox                                      | Q157, Q174 |

### Out-of-band CLIs

Two CLIs are **not** started by the maintenance workflow, and its `choice`
input lists neither: the bootstrap CLI, which an operator runs out of band as
`002` designed it (Resolved decision Q91), and `044`'s break-glass
`recover:admin-mfa`, which stays out of band under just-in-time access (Azure
PIM) (Resolved decision Q155), see
[Operator CLI](#operator-cli-recover-admin-mfa). `CODEOWNERS` still covers both,
because they live under `apps/api/scripts/`.

## Change procedure

Rotation procedure, the same for every secret:

1. Create a new version of the secret in Key Vault. Never edit a value in the
   Container Apps configuration directly.
2. For a database role password, first `ALTER ROLE ... PASSWORD` on the server
   (using an administrative role), then update the Key Vault secret and the
   URL that embeds it (`DATABASE_URL`, `AUTH_DATABASE_URL`,
   `PURGE_DATABASE_URL` or `REVERSAL_DATABASE_URL`).
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
