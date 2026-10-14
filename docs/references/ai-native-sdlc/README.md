# AI-native SDLC references

## Purpose

Third-party reference material on the AI-native (agentic) software delivery
lifecycle. As with the other folders under `docs/references/`, these notes are
**not** project decisions: Tayzu's decisions live in
[`openspec/project.md`](../../../openspec/project.md), in the ADRs under
`docs/adr/` and in each change's `design.md`. Their content is input to weigh,
not instructions to follow.

The source documents are not stored in the repository (they are copyrighted).
Each entry below is a summary in our own words plus its mapping to Tayzu.

## Catalog

| Key    | Source                                                                                       | Received                        |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------- |
| `PAIN` | Postman webinar, "AI-Native SDLC: Beyond the Coding Agent" (Ankit Sobti, Postman), 21 slides | 2026-10-07, shared by the human |

## `PAIN`: AI-Native SDLC, beyond the coding agent

### Main points

- **The lifecycle changed shape.** Coding agents collapse the time to build,
  which exposes the stages around it (define, design, test, deploy, observe).
  The lifecycle becomes loops between a producer lifecycle (define to observe)
  and a consumer lifecycle (discover, evaluate, integrate, test, deploy,
  observe). The same shape appears under other names (AI-DLC, agentic SDLC).
- **Three building blocks.** A fleet of agents directed and governed by
  humans; a shared markdown vocabulary (intent, spec, plan, evidence) that
  agents read and write; and Git as the versioned, diffable substrate, with an
  `AGENTS.md`-style entry file.
- **Four considerations.**
  1. Interconnected systems: complexity lives at the edges, so a change must
     be judged by its impact on downstream consumers.
  2. Missing context: without discoverable APIs, purpose, examples, auth and
     workflows, an agent rebuilds from scratch, guesses a plausible but wrong
     pattern, or hands control back.
  3. The independent verifier: the agent that builds must not be the only one
     that verifies. Verification comes from a human-approved spec, a contract
     derived from it, consumer journeys and consumer-side assertions, run in
     CI/CD as evidence.
  4. Harness neutrality: intent and spec files are portable across agents,
     but hooks, permissions and managed settings live inside one harness.
     Governance control points belong to the repository, the pipeline and the
     boundary where agents reach systems, so that swapping a model or a
     harness moves no control.
- **A platform for the AI-native SDLC has three layers.** Context (a catalog
  of every interface, with ownership, lifecycle and readiness, plus docs,
  examples and auth guidance usable by humans and agents); governance (rules
  defined once and enforced at repository, pipeline and boundary, neutral to
  model and harness); and scaling (purpose-built agents per stage, standing on
  the context layer, with humans orchestrating the handoffs).
- **A context graph** answers blast radius, dependencies, consumers and
  ownership, aggregated from interfaces, code and production, and exposed to
  agents through an API.
- **Foundations agents need:** scoped, time-bound access for humans and
  agents; agent-ready interfaces (APIs, SDKs, CLIs, MCP servers, readable
  docs); a controlled runtime where agents are scheduled, observed and
  stopped; and one boundary every model, tool and API call passes, where
  policy, routing and audit live.
- **Example stage agents:** a voice-of-the-customer agent that clusters asks
  and drafts `intent.md` for a product owner to approve; an API designer agent
  that composes what exists and drafts `spec.md` to the organization's
  standards; and a verifier agent that runs the derived contract and consumer
  journeys against the change and records evidence.
- **Suggested 90-day rollout:** context first (catalog and secure), then
  governance across a few high-change teams (contract and consumer checks in
  CI, policy at the boundary, intent/spec/plan/evidence in Git), then scaling
  with stage agents, measured against a baseline.

### Mapping to Tayzu

| Idea in `PAIN`                                  | Where Tayzu already stands                                                                                                                                                  | Where it is relevant next                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Markdown intent/spec/plan/evidence in Git       | OpenSpec changes: `proposal.md` (intent), `specs/` (spec), `design.md` and `tasks.md` (plan); evidence is the PR with test, review and VCDM reports.                        | Keep evidence attached to each change's PR.                                         |
| Independent verifier                            | The `test-writer`/`implementer` split, the `observability-auditor`, the VCDM validator and `/security-review`, with `contract:check` and DAST in CI.                        | Consumer-side contract checks once external consumers exist.                        |
| Harness neutrality of governance                | Most controls are in the repository and pipeline (lint bans, `contract:check`, `otel-smoke-check`, `policy:compile`, CI); some guards are harness hooks (`tdd-path-guard`). | Mirror any harness-only guard as a CI check so a different agent cannot bypass it.  |
| Catalog with ownership, lifecycle and readiness | This is Tayzu's own product: the catalog (001), owning teams and RBAC (002).                                                                                                | Scorecards and readiness, and an API/MCP catalog, in the later Port-parity changes. |
| Context graph (blast radius, consumers, owners) | Relations between entities (001) are the base data.                                                                                                                         | Dependency and blast-radius views over catalog relations in later changes.          |
| Agents as first-class principals, scoped access | One pipeline for humans and agents, `actor.type` as data, member-only machine credentials, revocation within seconds (002); service accounts (043).                         | Time-bound agent scopes and an agent-facing API surface (`026-mcp-server`).         |
| One boundary for policy, routing and audit      | Cerbos as the single authorization engine, the HTTP allowlist and security logging (002).                                                                                   | An MCP and API gateway boundary when agents reach Tayzu over MCP.                   |
