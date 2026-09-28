# ADR-0011: The catalog API is not served over the network before authentication

- **Status**: Accepted
- **Date**: 2026-09-28
- **Change**: [`001-catalog-core`](../../openspec/changes/archive/2026-09-28-001-catalog-core/design.md) (design D2)

## Context

`001-catalog-core` builds the catalog's procedures, their input and output
schemas, error mapping and the OpenAPI 3.1 contract. Authentication (Better
Auth) and authorization (Cerbos) arrive in `002-auth-and-rbac`. Until then
nothing can establish who a caller is or which tenant they belong to.

## Decision

1. The oRPC router, its schemas, the error mapping and the committed
   `openapi/catalog.openapi.json` all ship in 001, and CI contract-checks
   them.
2. The procedures are invoked **in-process only**, with
   `createRouterClient(router, { context })`, where the trusted host
   supplies the context. No Fastify app, HTTP listener or other network
   entry point exists until 002 puts authentication and Cerbos in front.
3. The context (`tenantId`, `actor`) is never part of a procedure's input.
   `contract:check` fails if any input declares `tenantId` or `actor`.

## Alternatives considered

- **A development-only header** (for example `X-Tenant-Id`) until 002.
  Rejected: it is a backdoor that bypasses governance, which the
  project's non-negotiable principle forbids. It also tends to get
  deployed by accident (SSA SEC02, SEC03).
- **No API layer until 002.** Rejected: the OpenAPI contract-check is
  mandatory in CI (Agentic TDD), and 003 needs a frozen contract to build
  against.

## Consequences

- 001 adds no network attack surface (SSA SEC02).
- 002 must mount the router behind authentication. It must also make the
  HTTP runtime read `DELETE`/`GET` inputs from the query string, as the
  OpenAPI document declares (design D11, follow-up T3).
- Tests and hosts call the catalog in-process, with the same pipeline and
  checks that HTTP callers will get.
