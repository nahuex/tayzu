# Secrets

Design D15 of `openspec/changes/002-auth-and-rbac/design.md`. Secrets come
only from the environment. In every deployed environment they are Azure Key
Vault secrets, referenced natively by Azure Container Apps and resolved into
environment variables at container start. Locally and in tests they come from
`.env` (git-ignored) or the shell. The application uses no Key Vault SDK.

`apps/api/src/config.ts` (`loadConfig`) validates them at startup. The
process refuses to start when a required value is missing, blank or
malformed. The error names the variable and never contains a value. No secret
is ever logged, traced or returned in an error response. The algorithms that
use these secrets are in the [Cryptographic inventory](crypto-inventory.md).

## Inventory

Everything `apps/api` reads from the environment. "Secret" means the value
must live in Key Vault; "Sensitive" means it is not a credential but reveals
topology or trust configuration, so it is still never logged or echoed.

| Variable                                                                                         | Class     | Purpose                                                                                                                | Validation                                                                                      |
| ------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                   | Secret    | Runtime pool as `tayzu_app` (password inside). Also what `db:migrate` reads today.                                     | Required, non-blank. `sslmode=verify-full` outside the test harness (`createPool`).             |
| `AUTH_DATABASE_URL`                                                                              | Secret    | Better Auth pool as `tayzu_auth`. Never falls back to `DATABASE_URL`.                                                  | Required, non-blank. `sslmode=verify-full` outside the test harness.                            |
| `BETTER_AUTH_SECRET`                                                                             | Secret    | Better Auth's one secret: cookie signing and the encryption key for the data below.                                    | Required, at least 32 characters.                                                               |
| `VISMA_CONNECT_CLIENT_SECRET`                                                                    | Secret    | OAuth client secret for Visma Connect.                                                                                 | All three `VISMA_CONNECT_*` variables or none. When any is set, each is required and non-blank. |
| `OTEL_EXPORTER_OTLP_HEADERS` and per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS`   | Secret    | Collector authentication headers, read by the OpenTelemetry exporters from the process environment, not by Tayzu code. | Not validated by Tayzu.                                                                         |
| `BETTER_AUTH_URL`                                                                                | Sensitive | Public base URL of the API (cookies, redirects).                                                                       | Required outside test and then `https`. Optional in test.                                       |
| `ALLOWED_ORIGINS`                                                                                | Sensitive | Comma-separated CORS and Better Auth trusted origins. The first one also builds the SSO step-up callback URL.          | Required. Outside test, every origin is `https` and wildcard-free. Never echoed.                |
| `CERBOS_ADDRESS`                                                                                 | Sensitive | `host:port` of the Cerbos gRPC endpoint. TLS is on unless it is `localhost`, `127.0.0.1` or `[::1]`.                   | Required, non-blank.                                                                            |
| `VISMA_CONNECT_DISCOVERY_URL`                                                                    | Sensitive | OIDC discovery document of Visma Connect.                                                                              | `https` outside test. Startup fails when it cannot be discovered. Never echoed.                 |
| `VISMA_CONNECT_CLIENT_ID`                                                                        | Sensitive | OAuth client id for Visma Connect.                                                                                     | See `VISMA_CONNECT_CLIENT_SECRET`.                                                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and per-signal `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Sensitive | OTLP collector URLs.                                                                                                   | One must be set outside test, unless `TAYZU_TELEMETRY_DISABLED=true`.                           |
| `TAYZU_TELEMETRY_DISABLED`                                                                       | Setting   | Explicit opt-out of telemetry export (Q41). Security logging must not be silently absent.                              | Unset or `false` is off, `true` is on, anything else fails startup.                             |
| `HOST`, `PORT`                                                                                   | Setting   | Listener address of `main.ts` (`HOST` defaults to `0.0.0.0`).                                                          | `PORT` is required, an integer from 0 to 65535.                                                 |
| `NODE_ENV`                                                                                       | Setting   | `test` relaxes the `https` checks, the `BETTER_AUTH_URL` requirement and the telemetry requirement.                    | Must never be `test` in a deployed environment.                                                 |

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
together with a startup assertion that the runtime roles are not superuser,
owner or `BYPASSRLS`, is a gate for the first deployment (Q58). Until then, do not assume the migrator role is separate in any
deployed environment.

The `jwt` plugin's signing key pair is generated by Better Auth and stored in
the database, with its private key encrypted with a key derived from
`BETTER_AUTH_SECRET`. Rotating that secret is therefore also how the signing
key's protection, and every other value encrypted under it, is rotated (see
below).

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
