# Port.io capability inventory — consolidated (Tayzu Phase 1)

Consolidates and deduplicates all capabilities found in the seven slice inventories
(`inv-context-lake-model.md`, `inv-context-lake-ingestion.md`, `inv-workflows.md`,
`inv-interface-builder.md`, `inv-governance-admin.md`, `inv-ai.md`,
`inv-solutions-guides.md`). Closely related micro-options (e.g. every catalog-table
UX toggle, or every SSO connector) are grouped into one row when they share the same
Tayzu change, so the table stays usable; the Summary column lists the grouped
sub-items. Every row carries exactly one `Tayzu change` id from
`roadmap-proposal.md`, or `out of scope: <reason>` for the small number of
Port-SaaS-commercial/hosting-only items. See `roadmap-proposal.md` for change
definitions, dependencies, and the coverage check against all 337 GAP/PARTIAL rows
of the seven source files.

Legend for the "Tayzu change" column: a bare id means the capability is in that
change's scope; `decision` means it is covered by an entry in
`roadmap-proposal.md`'s "Decisions for the human" section before a change id can be
assigned with confidence.

---

## 1. Context Lake — Data model (blueprints, properties, relations, ontology)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Blueprint definition (identifier/title/description/icon/schema/required) | The tenant-defined "class" of the catalog | `/context-lake/data-model/setup-blueprint/overview.md` | 001-catalog-core |
| Blueprint CRUD (UI, API) | Create/edit/delete blueprints | same | 001-catalog-core (API), 003-catalog-ui-core (UI) |
| Essential property types (string, number, boolean, object, array, enum, URL, date-time) | Core scalar/composite types | `/context-lake/data-model/setup-blueprint/properties/overview.md` | 001-catalog-core |
| String validation (minLength/maxLength/pattern) | Field-level input validation | `/properties/string.md` | 001-catalog-core |
| Relations: single/many, `required` flag, forward/backward traversal | Typed, directed edges between blueprints | `/setup-blueprint/relate-blueprints.md` | 001-catalog-core |
| Port Team/User property types | Typed references to internal Team/User entities | `/properties/team.md`, `/user.md` | 002-auth-and-rbac |
| Meta-properties (`$identifier`,`$title`,`$team`,`$icon`,`$createdAt/By`,`$updatedAt/By`,`$blueprint`) | Fields present on every entity by default | `/properties/meta-properties.md` | 001-catalog-core (timestamps/authorship, already designed) + 002-auth-and-rbac (`$team`) + 003-catalog-ui-core (`$icon`) |
| Default/system blueprints: `service`, `environment`, `workload`, `deployment` | Pre-built SDLC blueprints with default entities | `/setup-blueprint/default-blueprints.md` | 016-observability-dogfood (extends Service/Deployment to the full set) |
| Protected system blueprints (`_user`,`_team`,`_scorecard`,`_rule`,`_rule_result`,`_ai_agent`,`_ai_invocations`,`_ai_conversation`,`_mcp_server`,`_workflow`) | Reserved, non-deletable platform blueprints | `/setup-blueprint/default-blueprints.md` | Spread across 002 (user/team), 001 (reserved-`_` mechanism, already designed), 006 (`_workflow`), 012/013 (scorecard/rule/rule_result), 026 (mcp_server), 028 (ai_agent/invocations/conversation) |
| Icon library + custom icon upload | ~300 built-in icons + enterprise custom upload | `/setup-blueprint/overview.md` | 003-catalog-ui-core |
| Enum values with custom colors | Visual color-coding in tables/UI | `/properties/string.md` | 003-catalog-ui-core |
| Change a property's type (immutable; migrate-and-recreate) | Type permanence + guided migration workflow | `/properties/overview.md` | 024-catalog-data-lifecycle |
| String sub-formats (Proto, Email, YAML) | Specialized string formats with dedicated rendering | `/properties/string.md` | 011-catalog-advanced-properties |
| Labeled URL object property | URL paired with a display label | `/properties/labeled-url-object.md` | 011-catalog-advanced-properties |
| Mirror property | Copies a value from a related entity (incl. chained relations, meta-properties) | `/properties/mirror-property.md` | 011-catalog-advanced-properties |
| Calculation property (incl. persistent/background-computed variant) | JQ/JSONata-derived property from other properties/relations, all output types/formats | `/properties/calculation-property.md` | 011-catalog-advanced-properties |
| Aggregation property (by entities, by property, path filter) | Count/sum/avg/min/max/median across a relation path, with forward/backward path filtering | `/properties/aggregation-property.md` | 011-catalog-advanced-properties |
| Timer property (TTL/expiration) | Fires `TIMER_EXPIRED` to the event trigger + audit log | `/properties/timer.md` | 011-catalog-advanced-properties |
| Embedded URL property (public + SSO/PKCE) | External page as a dedicated entity-page tab | `/properties/embedded-url.md`, `/embedded-url/authentication.md` | 011-catalog-advanced-properties |
| Swagger UI property | Renders OpenAPI/AsyncAPI in an entity tab with live "try it" | `/properties/swagger.md` | 011-catalog-advanced-properties |
| Markdown property | Formatted markdown on an entity page | `/properties/overview.md` | 011-catalog-advanced-properties |
| Owning Teams property mechanic (hidden relation to Team, once per blueprint) | Sets blueprint ownership type | `/properties/owning-teams.md` | 002-auth-and-rbac |
| Multi-source ingestion (relations, array properties, ownership) | Each writer owns a named slice of a many-valued field; reads return a deduplicated union | `/relate-blueprints.md#multi-source-ingestion`, `/business-context/ownership.md` | 023-integrations-generic-webhook-and-connector-framework |
| Ontology-quality guidance (descriptions/precise types as agent-readable signal) | Turns the schema into a knowledge graph agents can reason over | `/data-model/define-your-ontology.md` | 028-ai-agents |
| Blueprint/permission management via Terraform/Pulumi (`port_blueprint`, import into state) | IaC for the catalog's own schema and data | `/data-model/iac/*.md`, `/other/iac/*.md` | 024-catalog-data-lifecycle (decision: full provider vs. export-only, see Decisions) |
| Natural-language blueprint/property authoring | Describe a blueprint in chat; AI generates/edits the schema | `/setup-blueprint/overview.md` | 030-ai-assistant |

## 2. Context Lake — Business context & ownership

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Business-context modeling pattern (cost, criticality, SLA, compliance, customer tier, DR tier) | Packaged guidance for enriching entities with risk/priority signals | `/business-context/overview.md` | 011-catalog-advanced-properties (properties) + 035-engineering-intelligence-metrics (packaged pattern) |
| Organization hierarchy modeling (Team self-relation, `type` enum, arbitrary depth) | Group>Team>Squad style hierarchies | `/business-context/organization-hierarchy.md` | 001-catalog-core (self-relation, already possible) + 005-search-and-query (`maxHops` traversal) + 020-dashboards-and-widgets (hierarchy views) |
| Ownership model: `ownership` property (None/Direct/Inherited), inherited-ownership + conflict fallback | Declares how an entity's owning team(s) are computed | `/business-context/ownership.md`, `/govern-data-access/examples.md#inherited-ownership` | 002-auth-and-rbac |
| User/Team sync from integrations (SSO/GitHub/GitLab/ADO/Jira mapping) | Links catalog user/team entities to external identities | `/business-context/ownership.md` | 025-sso-and-identity-federation + 021-integrations-devops-batch |
| Out-of-the-box ownership self-service actions ("Register your user", "Add team members", "Own services") | Pre-built onboarding self-service workflows | same | 036-solutions-resource-management |
| Default User/Team entity pages + "My"/"My Teams" filters | Built-in pages/filters scoped to the logged-in identity | same | 003-catalog-ui-core |
| Ownership management dashboard recipe | Assignment tables + "users with no team" chart + action card | same | 020-dashboards-and-widgets |

## 3. Context Lake — Ingestion strategy & mapping engine

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Canonical entity ingestion shape (identifier/title/team/blueprint/properties/relations) | Shape every ingestion path must produce | `/ingestion/overview.md` | 001-catalog-core |
| Five ingestion method families (native integration, MCP connector, API, webhook, custom) with decision guide | Helps pick the right path per source | same | 004-integrations-sdk-core (integration/API/webhook) + 027-mcp-connectors-external (MCP-connector family) |
| MCP connectors as ingestion class (live, unpersisted AI access) | Query a tool live without persisting to the catalog | `/ingestion/integrations-vs-mcp.md` | 027-mcp-connectors-external |
| AI-driven catalog auto-discovery (suggest missing entities/relations) + review/approve UI + API | Analyzes existing data to find gaps | `/ingestion/catalog-auto-discovery.md` | 024-catalog-data-lifecycle |
| Mapping engine: resources/kinds + selectors (extraction) and query/data-filter (transform) | Two-phase per-integration pipeline | `/configure-mapping/overview.md` | 004-integrations-sdk-core |
| Relation mapping via identifier or search-query rule; "map by property" create-or-update | Populate relations/identify entities without a shared ID scheme | same | 004-integrations-sdk-core |
| `itemsToParse` (expand one API field into N entities) | E.g. one issue → many comment entities | same | 004-integrations-sdk-core |
| Advanced mapping flags (`createMissingRelatedEntities`, `deleteDependentEntities`, `entityDeletionThreshold`) | Global auto-create/delete controls | same | 004-integrations-sdk-core |
| Mapping test playground (per-resource + public JQ/JSONata playground) | Validates a mapping before saving | `/configure-mapping/overview.md`, `configuration-methods.md` | 023-integrations-generic-webhook-and-connector-framework |
| Dual mapping editors (visual form + code YAML) with AI-assisted authoring | Non-engineers and engineers configure the same mapping | `/configure-mapping/configuration-methods.md` | 023-integrations-generic-webhook-and-connector-framework |
| Guided stale-entity cleanup (3-step) + bulk delete + export-before-delete | Safe retirement of a resource type/integration | `/configure-mapping/entity-cleanup.md` | 024-catalog-data-lifecycle |
| Migrate Blueprint Data tool | Bulk JQ/JSONata-based property/relation remap, dry-run, partial-failure report | `/other/migrate-data.md` | 024-catalog-data-lifecycle |
| Generic REST CRUD via API (get/create/create-or-update/upsert-merge/delete/delete-all) | Any system can push/pull catalog data directly | `/api/ingest-via-api-overview.md` | 001-catalog-core |
| Advanced API query params (`delete_dependents`, `create_missing_related_entities`) + documented rate limits | Fine-grained relation-integrity side effects; client expectations | `/api/advanced.md` | 004-integrations-sdk-core |
| Client-credentials token exchange for API/CI | Standard machine-auth flow | `/api/ingest-via-api-overview.md` | 002-auth-and-rbac |
| Dedicated CI/CD reporter integrations (GitHub Action, GitLab CI, Jenkins, CircleCI, Codefresh, Azure Pipelines) | Turnkey "report from CI" building blocks | `/api/ci-cd.md` | 004-integrations-sdk-core (GitHub, Azure DevOps) + 039-integrations-long-tail-backlog (the rest) |

## 4. Context Lake — Custom integrations & the Ocean SDK

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Standalone Ocean-equivalent SDK (CLI scaffolding, lifecycle hooks, local dev loop) | Golden-path scaffolding for a brand-new adapter | `/custom-integration/ocean-custom-integration/standalone.md` | 004-integrations-sdk-core |
| No-code generic REST connector ("Ocean custom": auth types, endpoints, JQ data path, hosted or self-hosted) | Connect a new REST API without writing an adapter | `/ocean-custom-integration/overview.md` | 023-integrations-generic-webhook-and-connector-framework |
| Ocean custom advanced config (nested/dependent endpoints, 5 pagination styles) | Handles real-world REST shapes without code | `/ocean-custom-integration/configuration.md` | 023-integrations-generic-webhook-and-connector-framework |
| Reusable declarative custom-auth (OAuth2 client-credentials, JWT, proactive/401-reactive refresh) | Dynamic auth beyond static tokens, shared across adapters | `/self-hosted/custom-authentication.md` | 004-integrations-sdk-core |
| Generic GitOps recipe (CI pushes `entity.json` to the API) | Documented Git-as-source-of-truth pattern with no dedicated integration | `/other/gitops.md` | 023-integrations-generic-webhook-and-connector-framework |
| S3-mediated ELT ingestion (Airbyte/Fivetran → S3 → webhook) | Any ELT-supported source reaches the catalog | `/other/s3-integrations.md` | 023-integrations-generic-webhook-and-connector-framework |
| Manual entity management (UI create/edit/enrich) | Fallback for data with no clean source of truth | `/other/manual-entity-management.md` | 001-catalog-core (API) + 003-catalog-ui-core (UI) |

## 5. Context Lake — Native integration lifecycle & sync mechanisms

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| 4 installation types (hosted-OAuth, hosted-custom-creds, self-hosted, CI-only) | Security/ease/infra tradeoffs per integration | `/native-integrations/overview.md#installation-methods` | 004-integrations-sdk-core |
| Full resync with reconciliation (delete stale, dependency-triggered reingest) | Keeps the catalog consistent with the source over time | `/sync-mechanisms/full-resync.md` | 004-integrations-sdk-core |
| Incremental sync (delta fetch, runs alongside full resync) | Reduces load/latency between full reconciliations | `/sync-mechanisms/incremental-sync.md` | 004-integrations-sdk-core |
| Live events (webhook/watch-API real-time updates) | Low-latency updates between resyncs | `/sync-mechanisms/live-events.md` | 004-integrations-sdk-core (already the "poll + webhook" pattern) |
| "Live events at scale" durable ingestion (dedicated gateway + Redis Streams) | No event loss on pod restart, independent consumer scaling | same | 004-integrations-sdk-core (build on BullMQ+Redis) |
| Sync-interaction rules + "apply mapping" fast-iteration mode | Predictable concurrent-sync behavior; remap cached data without re-fetch | `/sync-mechanisms/sync-interactions.md` | 004-integrations-sdk-core |
| Per-integration monitoring/sync-status UI + management API (list/get/update/delete, event logs, metrics) | Operational visibility into each integration's health | `/sync-mechanisms/full-resync.md`, `/overview.md#manage-integrations-via-api` | 004-integrations-sdk-core |

## 6. Context Lake — Native integrations by category (see Appendix A for the full name list)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Git providers (GitHub Ocean, GitLab v2, Bitbucket, Azure DevOps) incl. legacy/current generations | Broad Git ecosystem coverage | `/available-integrations/git.md` | 004-integrations-sdk-core (GitHub) + 021-integrations-devops-batch (Azure DevOps) + 039-integrations-long-tail-backlog (GitLab, Bitbucket) |
| GitHub depth features (repo search selection, archived-repo exclusion, multi-org, parallel webhooks, rate-limit reservation, file/README/CODEOWNERS enrichment, `file`-kind ingestion, monorepo folder mapping) | Real-world scale/enrichment features of the reference adapter | `.../git/github-ocean/capabilities.md` | 004-integrations-sdk-core |
| GitOps via `port.yml` in repos / Kubernetes CRDs | Developer-owned catalog entities as code | `.../git/github-ocean/gitops.md`, `.../kubernetes/port-crd.md` | 023-integrations-generic-webhook-and-connector-framework (`port.yml`); out of scope: Kubernetes CRDs (project.md §1 excludes a K8s control plane in Phase 1) |
| Ingest Agent Skills / Agent Plugins / MCP server definitions from repos | Catalogs the AI-tooling ecosystem itself as entities | `.../git/github-ocean/capabilities.md#ingest-agent-skills` | 031-ai-registry-skills-and-prompts |
| Cloud providers (AWS v3/legacy, Azure, GCP) + Kubernetes exporter | Multi-cloud/K8s resource inventory | `/cloud-providers/*.md`, `/kubernetes-stack/kubernetes.md` | out of scope: project.md §1 explicitly defers a multi-cloud/multi-cluster control plane to Phase 2/3 |
| CI/CD (Jenkins, Octopus Deploy, ArgoCD), APM/alerting, code quality/security (beyond Aikido), incident mgmt, project mgmt (beyond Jira Cloud), cloud cost, event processing (Kafka), feature flags, identity providers, automation platforms, AI usage metrics, Terraform Cloud, other (Amplication/Backstage/Slack) | ~40 remaining native-integration categories | `/native-integrations/available-integrations/*.md` | 039-integrations-long-tail-backlog (see Appendix A for per-tool assignment) |
| Deprecation/migration guides between integration generations | Structured upgrade paths as adapters evolve | `.../migration/*.md` | 004-integrations-sdk-core (process to follow once Tayzu's own adapters iterate; not a feature) |

## 7. Context Lake — Webhooks

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Generic, self-serve webhook connector (JQ/JSONata-mapped CRUD, filter expr, multi-blueprint, `itemsToParse`, 500-item batches) | Reusable primitive for any outgoing-webhook tool | `/webhook/ingest-via-webhooks-overview.md` | 023-integrations-generic-webhook-and-connector-framework |
| Webhook security config (HMAC signature verification, plain-secret mode) | Verifies payload authenticity per webhook | same | 023-integrations-generic-webhook-and-connector-framework |
| Async webhook processing (`202 Accepted`, queued ingestion, payload-size limit) | Fast ack while ingestion happens in the background | same | 023-integrations-generic-webhook-and-connector-framework (built on BullMQ) |
| Webhook management via API/Terraform | Provision webhook connectors as code | same | 024-catalog-data-lifecycle |
| Hard-coded webhook adapters (Orca Security, CodeRabbit) | Purpose-built adapters for two priority security tools | project.md §8 | 022-integrations-security-batch |

## 8. Consuming the lake — Search & query

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Unified search/query DSL (`combinator` and/or + nested `rules`) | One filter language reused everywhere (pages, tabs, dashboards, permissions, aggregations, scorecards, actions, API) | `/search-and-query/overview.md`, `structure-and-syntax.md` | 005-search-and-query |
| Comparison operators (full set: `=`,`!=`,ranges,`contains`,`in`,`between`, etc.) | Property-value filtering | `/operators/comparison-operators.md` | 005-search-and-query |
| Relation operators (`relatedTo`, `matchAny` with `path`+`maxHops`, self-relation traversal) | Graph filtering/traversal, incl. depth-limited hierarchy walks | `/operators/relation-operators.md` | 005-search-and-query |
| Contextual query rules (`context: user`/`userTeams`) | "Current user"/"current user's teams" resolved at eval time | `/structure-and-syntax.md#contextual-query-rules` | 005-search-and-query |
| Filter by relation/scorecard/rule in the search API; API tuning params (`attach_title_to_relation`, `exclude_calculated_properties`) | Search-route filtering and response shaping | `/structure-and-syntax.md`, `/advanced.md` | 005-search-and-query |

## 9. Consuming the lake — Governance (catalog RBAC)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Blueprint-level entity permissions (read/register/unregister/update/updateProperties/updateRelations) by role/user/team/`ownedByTeam`/dynamic policy | Fine-grained runtime CRUD access control | `/govern-data-access/overview.md` | 002-auth-and-rbac |
| Property-level read/update restrictions | Hide/lock individual properties per role | same | 014-governance-and-policy-simulation |
| Global-vs-granular permission precedence | `update` overrides `updateProperties`/`updateRelations` | `/govern-data-access/examples.md` | 014-governance-and-policy-simulation |
| Permission simulator (blast-radius / "why can X do Y") via UI/API/AI | Test rules against a real user before saving | `/govern-data-access/overview.md#permission-simulator` | 014-governance-and-policy-simulation |
| Terraform/Pulumi-managed permissions | IaC for blueprint permissions | same | 024-catalog-data-lifecycle |

## 10. Consuming the lake — MCP, CLI & external automation

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Outbound MCP server (query catalog, run workflows, manage resources from an IDE/agent) | Exposes the same tools that power in-house agents to any MCP client | `/port-mcp-server.md`, `/agent-management/port-mcp-server/overview.md` | 026-mcp-server |
| Token-based CI/CD auth for MCP | Non-interactive auth for pipeline MCP calls | `/port-mcp-server.md` | 026-mcp-server |
| Developer CLI (raw-JSON, pipeable, org export/import/compare/migrate) | Scriptable API client for humans and agents | `/consuming-the-lake/overview.md`, `/port-ai/interfaces/port-cli.md` | 033-developer-cli |
| External automation-platform connector pattern (n8n custom node, generic "other consumption methods") | Lets low-code platforms drive workflows off catalog data | `/other-consumption-methods/*.md` | 039-integrations-long-tail-backlog |
| MCP connectors (register external MCP servers so agents can call their tools live) | Governed gateway *inward* to third-party MCP servers | `/extend-the-context-lake.md` | 027-mcp-connectors-external |
| Skills (publish reusable instruction packages for agents) | Domain-specific playbooks agents load mid-task | `/extend-the-context-lake.md` | 031-ai-registry-skills-and-prompts |

---

## 11. Workflows — Core engine & concepts

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Workflow = directed graph (trigger/action/condition/input nodes + edges), metadata, multiple triggers | Unified engine replacing self-service actions + automations | `/workflows/concepts.md` | 006-workflow-engine-core |
| Optimistic-concurrency editing (`workflowVersionIdentifier`/`If-Match`) | Prevents silent overwrite of concurrent edits | same | 006-workflow-engine-core |
| Reusable/child workflows (parent invokes child, correlation by run id) | Composable workflow graphs | `/reusable-workflows.md` | 006-workflow-engine-core |
| Manage workflows via Terraform/Pulumi | IaC for the workflow graph | `/build-workflows/iac.md` | 024-catalog-data-lifecycle (decision: provider vs. export) |
| Partial re-run from a failed node | Re-run starting at the failed node, not from scratch | project.md §4 (Tayzu is ahead of Port here) | 007-workflow-runs-and-execution |
| Four authoring surfaces produce the same graph | Visual editor, JSON, AI conversation, IaC | `/workflows/overview.md` | 008-workflow-canvas (visual+JSON), 009-workflow-ai-authoring (AI), 024 (IaC) |

## 12. Workflows — Triggers

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Manual/self-service, Event, Schedule, Agent-tool triggers | The four trigger kinds, each with its own permissions | `/build-workflows/*-trigger*.md` | 006-workflow-engine-core |
| Trigger publish/unpublish toggle | Disable without deleting | same | 006-workflow-engine-core |
| Scorecard rule-result trigger enrichment (`impactedEntity`) | Event trigger auto-resolves the graded entity | `/event-trigger.md` | 013-scorecards-integrations-and-groups |
| Contexts: surface trigger in "create entity" flow / entity bolt menu, with dataset filters & alert styling | Guided-workflow entry points from the catalog UI | `/self-service-trigger/contexts.md` | 010-workflow-self-service-forms |
| Custom trigger button text; shareable pre-filled workflow URL | UX affordances for self-service triggers | `/self-service-trigger/configuration.md`, `/send-link-to-workflow.md` | 010-workflow-self-service-forms |
| Action-run-as-trigger (fire on another run's status change) | Legacy Automations pattern with no equivalent trigger type today | `/actions-and-automations/define-automations.md` | 006-workflow-engine-core |

## 13. Workflows — Action & flow-control nodes

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Webhook action (sync/async, timeout policy) | HTTP call with templating | `/action-nodes/webhook.md` | 006-workflow-engine-core |
| Upsert-entity action | Create/update a catalog entity from workflow data | `/action-nodes/upsert-entity.md` | 006-workflow-engine-core |
| Kafka action/backend (per-org externally-consumable topic) | Publishes to a per-tenant topic for external consumers | `/action-nodes/kafka.md` | decision (Kafka vs. BullMQ/webhook fan-out — see Decisions) |
| Integration action nodes (GitHub, Azure DevOps, Jira, GitLab, Linear) | Trigger pipelines/PRs/issues from a workflow node | `/action-nodes/integration-actions/*.md` | 006 generic node type; 004 (GitHub), 021 (Azure DevOps, Jira) already wired; GitLab/Linear → 039-integrations-long-tail-backlog |
| External-agent orchestration nodes (Claude Managed Agents, Cursor Cloud Agents) | Start/continue a session with a vendor-hosted managed-agent product from a workflow node | `/action-nodes/integration-actions/ai/*.md` | 028-ai-agents (decision: build vs. skip — see Decisions) |
| Port-execution-agent style private-network relay | Self-hosted relay reaching backends with no inbound ingress | `/action-nodes/port-execution-agent.md` | decision: out of scope for Phase 1 (ACA assumes reachable webhook targets); revisit in Phase 2/3 |
| AI action node (invoke named agent / ad hoc invocation, tool allow-list, ≤5 MCP connectors, structured output, `load_skill`) | Workflow node that calls an AI agent or ad hoc model call | `/action-nodes/ai.md` | 028-ai-agents (invoke named agent) + 030-ai-assistant (ad hoc/structured output) + 031 (`load_skill`) |
| Condition node (ordered JQ/JSONata outlets, fallback, status labels) | First-match branching | `/flow-nodes/condition.md` | 006-workflow-engine-core |
| Input node (human-in-the-loop gate: responders, thresholds, button outlets) | Pauses the run for a governed human decision | `/flow-nodes/input.md` | 006-workflow-engine-core (generic) + 034-notifications-and-slack (Slack-channel responses) |
| Node-level `onFailure`, `links`, `verbose` logging | Per-node run-behavior and debugging config | `/action-nodes/configuration-and-outputs.md` | 006-workflow-engine-core (onFailure) + 007-workflow-runs-and-execution (links, verbose) |
| `variables` output reshaping | Post-execution transform of a node's default output | `/data-flow.md` | 006-workflow-engine-core |

## 14. Workflows — Data flow, templating & secrets

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| `.outputs["node"]` / `.outputs.trigger` referencing | Cross-node data flow | `/data-flow.md` | 006-workflow-engine-core |
| Workflow run context variables (`.workflow.*`,`.workflowRun.*`,`.workflowNodeRun.*`) | JQ/JSONata-addressable run metadata for tracing/audit | same | 006-workflow-engine-core |
| Fetch catalog data mid-workflow | Webhook/action nodes pull related entities into the run | same | 006-workflow-engine-core (via 001's entity API) |
| Org-level secrets store (`.secrets["name"]` in templates) | Reusable secret references in webhook/action templates | same | 006-workflow-engine-core |
| Secret user-input type (server-managed AES-256-GCM or BYO RSA-hybrid client-side encryption) | Masked, encrypted self-service form field | `/user-inputs/secret.md` | 010-workflow-self-service-forms |

## 15. Workflows — Self-service forms

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Standard input types (text/number/toggle/entity/user/team/datetime/url/email/array/object/YAML) | Form field type catalog | `/self-service-trigger/configuration.md` | 003-catalog-ui-core / 010-workflow-self-service-forms (JSON-Schema-driven generator) |
| Dependent/dynamic defaults, conditional visibility/disabled, validation rules (JQ/JSONata) | Cross-field, context-aware form logic | `/advanced-input-configurations.md` | 010-workflow-self-service-forms |
| Multi-step forms with per-step validation | Wizard-style large forms | `/setup-ui-for-action.md` | 010-workflow-self-service-forms |
| Entity-input dataset filters | Restrict a dropdown via search rules | `/advanced-input-configurations.md` | 010-workflow-self-service-forms (built on 005) |
| Input ordering (`order` array) | Explicit display order | `/user-inputs/structure-and-fields.md` | 010-workflow-self-service-forms |
| Setup checklist (missing integrations/secrets) + deferred integration installation | Admin panel resolving unwired dependencies on a saved workflow | `/setup-checklist.md`, `/integration-actions/overview.md` | 010-workflow-self-service-forms |

## 16. Workflows — Authoring, testing & management

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Visual graph editor + raw JSON editor | Drag/connect canvas and full-JSON edit, same underlying graph | `/build-workflows/quickstart.md` | 008-workflow-canvas |
| AI-assisted natural-language builder | Describe intent; AI proposes the graph for review | same | 009-workflow-ai-authoring |
| Test-run a draft (mocked node outputs, single-node + ancestors execution) | Validate before publishing | `/test-workflows.md` | 008-workflow-canvas |
| Visual run-replay page + per-node run detail panel | Live per-node status overlay on the exact graph version used | `/track-workflow-execution/workflow-run-page.md` | 008-workflow-canvas |

## 17. Workflows — Permissions & governance

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Static + dynamic (policy) execute permissions per trigger | Who can see/run each trigger | `/workflows/permissions.md` | 002-auth-and-rbac |
| Execution-source-aware policy (block MCP-triggered runs, etc.) | Restrict by invocation origin, not just identity | same | 014-governance-and-policy-simulation |
| Workflow catalog build permissions (edit vs. execute as two independent layers) | ACL on the workflow *definition* itself | `/workflow-catalog.md`, `/manage-workflows.md` | 014-governance-and-policy-simulation |
| Machine-token vs. human-principal permission semantics | Machine tokens bypass static role checks, never `policy` rules | `/expose-as-tool.md`, `/permissions.md` | 002-auth-and-rbac |
| "Trigger on behalf of" (`run_as`) + run-visibility toggle | Delegated execution; who can see run history | `/set-self-service-actions-rbac.md`, `/track-and-manage-runs.md` | 014-governance-and-policy-simulation |

## 18. Workflows — Run management & observability

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Workflow run object (status/result/node-run list/timestamps) | Core `WorkflowRun` model | `/track-and-manage-runs.md` | 006-workflow-engine-core |
| Node-run reporting API (external backends PATCH status/output, POST logs) + attach links | Async/execution-agent callback contract | same | 007-workflow-runs-and-execution |
| Cancel a run (graceful/force) | Stop in-flight or force-fail nodes | `/track-and-manage-runs.md`, `/workflow-run-page.md` | 007-workflow-runs-and-execution |
| Full-run log viewer with search | All nodes' logs, searchable | `/workflow-run-page.md` | 007-workflow-runs-and-execution |
| Re-run with same inputs (one-click) | Re-execute a past run's exact input set | `/reflect-action-progress.md` | 007-workflow-runs-and-execution |
| Tie arbitrary entity mutations to a run (`run_id`) | Any entity write tagged to a run shows as "Affected Entities" | same | 007-workflow-runs-and-execution |
| Embeddable workflow-runs-history table widget | Sortable run table for dashboards/entity pages | `/workflow-run-page.md` | 020-dashboards-and-widgets |
| Entity-page "Runs" tab | Per-entity run history UI | `/interface-builder/.../entity-page.md` | 007-workflow-runs-and-execution (data) + 003-catalog-ui-core (tab) |

## 19. Workflows — Backends (execution targets)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Webhook, GitHub Actions, Azure DevOps pipeline, Create/update-entity backends | Core execution targets already in Tayzu's priority list | `/setup-backend/*.md` | 006-workflow-engine-core (generic) + 004 (GitHub) + 021 (Azure DevOps) |
| GitLab pipeline, Jenkins pipeline, Terraform Cloud backends | Additional CI/CD execution targets | `/setup-backend/*.md` | 039-integrations-long-tail-backlog |
| Send-Slack-message backend | Dedicated Slack notification target | `/setup-backend/send-slack-message.md` | 034-notifications-and-slack |
| Webhook signature verification (outbound Tayzu→backend) + static outbound IP allowlisting | Lets backends trust and firewall-allow inbound calls from Tayzu | `/setup-backend/webhook/*.md` | 006-workflow-engine-core (signatures); outbound-IP strategy is an infra decision, see Decisions |

## 20. Workflows — Agent/AI integration

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Every self-service workflow auto-exposed as an MCP tool (`list_self_service_triggers`, `trigger_run`) | No separate registration step | `/expose-as-tool.md` | 026-mcp-server |
| Tool-description-as-agent-instructions authoring convention | `description` fields written for the agent, not just the UI | same | 026-mcp-server |
| Agent-triggered workflow examples (diagnosis→approval→fix) | Documented event→AI→human-gate→automation pattern | `/use-cases-and-examples.md` | 028-ai-agents |

## 21. Workflows — Legacy actions & automations

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Self-service actions + Automations (pre-unification systems) | Superseded by Workflows; Tayzu builds the unified engine directly | `/actions-and-automations/*.md` | N/A — deliberately not replicated (project.md §4); no gap |
| Dynamic RBAC via catalog queries (legacy `policy.queries`/`policy.conditions`) | Predecessor of Cerbos-based dynamic policy | `/dynamic-permissions.md` | 002-auth-and-rbac (Cerbos is the intended replacement) |

---

## 22. Interface builder — Global search & catalog pages

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Global search (Cmd+K, categorized results, per-org/per-blueprint indexing) | Cross-entity search overlay | `/interface-builder/global-search.md` | 003-catalog-ui-core |
| Catalog page (default per-blueprint table) + manual extra pages | Auto-created and admin-created table views | `/page/catalog-page.md` | 003-catalog-ui-core |
| Table UX toolkit: initial/server-side filters, excluded properties, persistent-calc perf, optimized/capped tables, filters incl. "My Teams"/"Me", multi-field sort, column show/hide/reorder, manage-properties shortcut, group-by, free-text search, save view (per-user + org), export CSV/JSON, 100k-entity scale ceiling, page description/lock/delete | The full catalog-table feature set | `/page/catalog-page.md` | 003-catalog-ui-core (rendering/UX) + 005-search-and-query (filter semantics) + 011 (persistent calc) + 024 (export) |
| Catalog auto-discovery entry point in the UI | Surfaces AI-suggested missing entities from the table | same | 024-catalog-data-lifecycle |

## 23. Interface builder — Entity pages

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| One entity-page layout per blueprint; Overview tab = dashboard with default Details widget | Blueprint-level layout, inherited by every entity | `/page/entity-page.md` | 003-catalog-ui-core |
| Manage-properties modal (hide empty/specific) | Per-widget property visibility control | same | 003-catalog-ui-core |
| Related-entities tab (auto direct relations) + custom tabs (indirect/self relations, path picker, filters, JSON mode) + self-relation `maxHops` traversal | Relationship exploration on the entity page | same | 003-catalog-ui-core (auto tab) + 005-search-and-query (path/`maxHops` semantics) |
| Runs tab | Workflow/action run history for this entity | same | 007-workflow-runs-and-execution (data) + 003 (tab) |
| Audit log tab (diffed change history) | Per-entity CRUD history with before/after | same | 015-platform-admin-audit-log |
| Auto-generated visual property tabs (Markdown/Embedded URL/Swagger) | Property-type-driven rendering | same | 011-catalog-advanced-properties |
| Scorecards tab | Compliance status against the blueprint's scorecards | same | 012-scorecards-core |
| Extra custom dashboard tabs (up to 5) + IaC management with reserved-tab validation | Admin-added tabs beyond the 4 reserved ones | same | 003-catalog-ui-core (tabs) + 024 (IaC) |

## 24. Interface builder — Dashboards, folders & private pages

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Dashboard page (freeform widget canvas): add/reorder/resize, duplicate, cross-widget filters, IaC | A page type distinct from catalog pages | `/page/dashboard-page.md` | 020-dashboards-and-widgets |
| Data widgets: number/pie/bar/line/multi-line chart, table widget, entity-card widget, chart drill-down, custom empty state, chart-level filters | Aggregate/visual data display | `/dashboards/data-widgets.md` | 020-dashboards-and-widgets |
| Personal widgets (My entities, Recently viewed, Recently used actions) | Home-page, per-user widgets | `/dashboards/personal-widgets.md` | 020-dashboards-and-widgets |
| Custom widgets: iframe (incl. OAuth), markdown (editable, image upload), links, workflow-card, action-history, AI Agent chat widget, plugin-container widget | Rich, extensible dashboard surfaces | `/dashboards/custom-widgets.md` | 020-dashboards-and-widgets (plugin container depends on 018; AI Agent widget depends on 028 — noted as fast-follow) |
| Sidebar folders (3 levels, drag-and-drop) | Groups pages by topic/team | `/page/folders.md` | 020-dashboards-and-widgets |
| Private pages (personal pages, sharing, promote/demote, limits) | User-created pages without admin gatekeeping | `/page/private-pages.md` | 020-dashboards-and-widgets |
| AI-generated onboarding dashboards + "ask AI to build a widget" | Conversational dashboard authoring | `/getting-started/view-dashboards.md` | 020-dashboards-and-widgets (surface) + 030-ai-assistant (generation) |

## 25. Interface builder — Page permissions

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Per-page view/edit permissions (users/teams/roles) + org-wide toggle | Admin-granted page ACL | `/page/page-permissions.md` | 014-governance-and-policy-simulation |
| Permissions apply identically to AI agents | Same ACL gates human and agent access | same | 014-governance-and-policy-simulation |
| PATCH-based partial permission updates; lock pages | Fine-grained ACL update semantics; disable end-user view customization | same | 014-governance-and-policy-simulation |

## 26. Interface builder — Plugins & custom widgets platform

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Plugin = single self-contained HTML artifact, hosted, no per-plugin infra | Core plugin packaging model | `/port-interface/plugins.md` | 018-plugins-sandbox |
| Plugin↔host postMessage protocol (`PORT_TOKEN`, `PLUGIN_DATA`, dialog/AI-chat bridge calls) | The sandboxing contract | `/dashboards/custom-widgets.md` | 018-plugins-sandbox |
| Plugin CSP directives, size/format limits | Concrete isolation policy | `/plugins.md` | 018-plugins-sandbox |
| Plugins SDK host-bridge helpers (`openAiChat`, `showRunActionDialog`, `showRunWorkflowDialog`) | Packaged JS helpers over the postMessage contract | same | 018-plugins-sandbox |
| Plugins CLI, curated plugins library/marketplace, Plugins Manager admin screen, plugin CRUD REST API, typed custom-widget parameters | Tooling around the plugin mechanism | same | 019-plugins-marketplace-and-cli |
| Plugin management via MCP (`list_plugins`,`upsert_plugin`, library install) | Agent-driven plugin lifecycle | same | 026-mcp-server |

## 27. Interface builder — Notifications & Slack

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Slack app (install, per-user OAuth, dynamic-channel routing, channel-name enrichment, `@Port` mentions/slash command/DMs, interactive forms, workflow input-node responses, AI-panel integration, bot rename, limits) | Slack as a first-class notification and AI-interaction surface | `/notifications/slack-app.md` | 034-notifications-and-slack (decision: build now vs. defer — see Decisions) |

## 28. Interface builder — Customization & accessibility

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Organization branding (title + logo), announcement banner, custom icon library | Org-wide visual customization | `/port-interface/customization.md` | 003-catalog-ui-core |
| Dark/light theme toggle | Already a day-one commitment (project.md §5) | same | 003-catalog-ui-core |
| Accessibility conformance (WCAG 2.2 A/AA, Section 508, EN 301 549) + hotkeys | Formal accessibility standard + keyboard shortcuts | same | 003-catalog-ui-core |

## 29. Interface builder — AI assistant surfaces (docs/onboarding)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Global "Ask AI" docs assistant (answers doc questions, generates resource JSON, debugs errors) | Public-docs-trained help copilot, distinct from a catalog agent | `/getting-started/docs-ai-assistant.md` | 030-ai-assistant |

---

## 30. Governance — Cross-pillar model

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Cross-pillar governance model (catalog/workflow/AI/interface permissions each in their own pillar) | Consistency principle across permission surfaces | `/governance/governance-across-pillars/overview.md` | 014-governance-and-policy-simulation |
| Team-based ownership permissions (`$team` + `ownedByTeam`) | Access follows the owning team on any blueprint | same | 002-auth-and-rbac |
| Dynamic, context-aware ABAC policies | Compare user vs. entity attributes at request time | same | 002-auth-and-rbac (Cerbos) |
| Natural-language policy authoring | Ask AI/an MCP agent to write a permission policy | same | 014-governance-and-policy-simulation |
| "View as" a different user | Admin impersonation session for permission testing | `/users-and-teams/view-as-different-user.md` | 014-governance-and-policy-simulation |
| Config-as-code rollout with review gates across environments | Promote workflows/scorecards/permissions with human approval | `/manage-port-across-environments.md` | 024-catalog-data-lifecycle |

## 31. Governance — Standards & compliance (Scorecards)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Scorecard core model (rules, levels, Basic→advance-on-all-pass) | Grading engine | `/standards-and-compliance/concepts-and-structure.md` | 012-scorecards-core |
| Rule condition language (operator set + and/or, nestable) + scorecard filters | Which entities are scored, and how | same | 012-scorecards-core |
| Scorecard/Rule/RuleResult as protected extensible system blueprints | Structural pattern, immutable core + extensible custom fields | same | 012-scorecards-core |
| Scale limits (up to 5M rule results) + async sync design | Large-blueprint scorecard evaluation performance | same | 012-scorecards-core |
| Scorecard views & dashboards (entity tab, catalog columns w/ aggregation, dedicated dashboards) | Standard scorecard consumption surfaces | same | 012-scorecards-core (tab/columns) + 020 (dashboards) |
| Manage scorecards (UI/API/Terraform, raw-JSON mode) | CRUD across surfaces | `/manage-scorecards.md` | 012-scorecards-core (UI/API) + 024 (Terraform) |
| Scorecard Groups (apply one rule set across multiple blueprints) | Shared or per-blueprint rule modes, aggregated reporting | `/manage-scorecard-groups.md` | 013-scorecards-integrations-and-groups |
| Extend scorecards for SLA tracking | Due-date properties + reminder/escalation automations | `/examples/extend-data-model.md` | 013-scorecards-integrations-and-groups |
| Scorecard as AI-agent dispatch guardrail | Pass/fail gate before routing to an AI-agent workflow step | `/examples/scorecard-use-cases.md` | 028-ai-agents |
| DORA-style metrics scorecards | Rules built on aggregation properties (deployment frequency, etc.) | same | 035-engineering-intelligence-metrics |
| Third-party compliance integrations (Jira/GitHub issue automation, Slack messaging, generic rule-result notifications) | Auto-create/close issues and notify on rule violations | `/manage-using-3rd-party-apps/*.md`, `/examples/automation-use-cases.md` | 013-scorecards-integrations-and-groups (generic) + 021-integrations-devops-batch (Jira/GitHub — moved here so `013` never depends on the later `021`, see Critic review) + 034-notifications-and-slack (Slack) |

## 32. Governance — Audit log

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Organization-wide audit log UI (all resource types, time-ordered) + diff view + source-type attribution | Compliance-grade change history, distinct from OTel traces | `/platform-administration/audit-log.md` | 015-platform-admin-audit-log |
| Retention policy + API access | 90-day default UI, full history via API | same | 015-platform-admin-audit-log |
| Non-admin self-service run history ("My inbox") | Users see their own runs without audit-log access | same | 015-platform-admin-audit-log |
| AI-agent run auditability | Agent runs appear in the same Runs view, attributed to the underlying identity | same | 015-platform-admin-audit-log |

## 33. Governance — Multi-org, plan & security posture

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Multiple organization membership, org switcher, account/company admin tiers, default login org, multi-org SSO architecture | Multi-org SaaS architecture | `/multi-org-management/*.md` | out of scope: project.md §6 targets "few known private tenants," not a multi-org-per-user switching UX (decision recorded — see Decisions) |
| Automatic user access (SSO auto-join) + per-org IdP team sync with filters | Auto-provisioning within a tenant's IdP | same | 025-sso-and-identity-federation |
| Per-org user status model (Active/Invited/Staged/Disabled) | User lifecycle state machine | `/user-membership-reference.md` | 002-auth-and-rbac |
| Cross-environment config promotion (Terraform/GitOps/CLI export-import-compare-migrate) | Promote catalog/workflow config between environments | `/manage-port-across-environments.md` | 033-developer-cli + 024-catalog-data-lifecycle |
| Plan-tier lifecycle policy (free-org auto-block/delete) | SaaS billing/plan enforcement | `/plan-management.md` | out of scope: Port-SaaS billing tier, no analogue for a private deployment |
| Formal compliance certifications (SOC2/ISO/GDPR) | Port-the-vendor's own compliance program | `/security.md` | out of scope: informational about Port as a vendor, not a configurable product feature |
| Private network connectivity (PrivateLink) | Keeps SaaS traffic off the public internet | same | out of scope: Tayzu already runs inside a VNET-integrated ACA environment (project.md §7) |
| Vendor/support impersonation access controls | Time-boxed Port-support access to a customer's org | same | out of scope: no third-party vendor-support tier for a self-hosted platform |
| Data retention & deletion policy (contract termination, 14-day backup window, on-demand API) | Formal data lifecycle policy | same | 002-auth-and-rbac |
| Multi-factor authentication | Native MFA + SSO-delegated MFA | same | 002-auth-and-rbac (Better Auth `two-factor` plugin) |
| Organization deletion (support-mediated) | Permanent tenant teardown | `/troubleshooting/general.md` | 002-auth-and-rbac |

## 34. Governance — SSO, SCIM & secrets

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Self-serve enterprise SSO wizard, SAML 2.0, OIDC, pre-built connectors (Okta/Entra/Google/OneLogin/JumpCloud), LDAP, SCIM, group-sync filters, session controls, domain verification | Full enterprise identity federation stack | `/sso-authentication/*.md` | 025-sso-and-identity-federation |
| Organization API credentials UI | View/copy client id/secret/org id | `/secrets-management/port-secrets.md` | 002-auth-and-rbac |
| Org secrets store for templating (`{{.secrets.NAME}}`) | User-facing secret store for workflow/action payloads | same | 006-workflow-engine-core |
| Three-tier RBAC role model (Admin/Blueprint Moderator/Member) | Named baseline role set | `/users-and-teams/manage-users-teams.md` | 002-auth-and-rbac |
| User & Team as core system blueprints, service accounts, invitation lifecycle | Identity-as-catalog-entities pattern | same | 002-auth-and-rbac |
| User-context in dynamic rules (`.user.*`) | Queryable user context inside policy/action conditions | same | 005-search-and-query |

## 35. Governance — Usage analytics & operational

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Portal usage dashboard (5 tabs: user activity, entities, actions, data sources, AI/MCP) | Company-wide adoption analytics | `/platform-administration/usage-dashboard.md` | 015-platform-admin-audit-log |
| Self-hosted execution agent (Kafka/HTTP-polling relay for air-gapped backends) | On-prem action-execution relay | `/troubleshooting/port-agent.md` | decision: out of scope for Phase 1 — see Decisions |
| Multiple self-service action backend types (webhook/GH Actions/GitLab CI/ADO/Kafka-direct/execution agent) | Backend diversity for triggering external systems | `/troubleshooting/actions.md` | 006 (webhook/GH/ADO) + 039 (GitLab CI) + decision (Kafka-direct, execution agent) |
| Catalog data export (JSON/GitOps YAML/Terraform HCL) | Bulk export from the UI | `/troubleshooting/general.md` | 024-catalog-data-lifecycle |
| Web session timeout policy | Inactivity + absolute re-login windows | same | 002-auth-and-rbac |

---

## 36. Port AI — Assistant & interaction surfaces

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Port AI base engine (MCP-client orchestrator, autonomous tool selection) | General natural-language Q&A/action assistant | `/port-ai/overview.md` | 030-ai-assistant |
| No-config chat assistant, chat modes (ask/plan/build) | Always-available UI chat with scoped tool surfaces | `/port-ai-assistant.md`, `/tools-and-approvals.md` | 030-ai-assistant |
| AI chat widget (dashboard embed) | Agent chat as a dashboard widget | `/agent-management/custom-agents/interact-with-ai-agents.md` | 020-dashboards-and-widgets (widget) + 030 (engine) |
| `/v1/ai/invoke` and `/v1/agent/<id>/invoke` with SSE streaming, request-level controls (`tools`,`chatMode`,`toolApprovalOverrides`,`mcpServers`,`provider`/`model`,`labels`) | General-purpose programmatic AI invocation API | `/port-ai/api-interaction.md` | 030-ai-assistant |
| Structured output (`outputSchema`) as a general invoke-API feature | Forces the AI's answer into a caller schema | same | 030-ai-assistant |
| AI-triggered automations via webhook (`/v1/ai/invoke` from an event/action) | Catalog events call the AI as a first-class recipe | same | 030-ai-assistant |
| Context-engineering practice (prompt design guidance, secure MCP-grounded access, skills as an extension) | Documented practice + supporting mechanisms | `/port-ai/context-engineering.md` | 030-ai-assistant (guidance) + 031 (skills) |

## 37. Port AI — LLM provider management, limits & security

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Bring-your-own-LLM provider registry (OpenAI/Anthropic/Azure/Bedrock/Vertex/compatible), per-request override, model overrides, connection validation, org default | Multi-provider abstraction beyond the single `DecisionProvider` implementation | `/llm-providers-management/*.md` | 029-ai-registry-llm-providers |
| Provider secrets (secret-store-backed, one-time-view) | AI-provider-specific credential handling | `/setup-and-configuration.md` | 029-ai-registry-llm-providers |
| Rate limits, monthly invocation quota + usage API, tool-calls-per-interaction cap, final-response token cap | Circuit breakers against runaway tool-calling loops | `/port-ai/limits-and-quotas.md` | 029-ai-registry-llm-providers |
| RBAC-scoped AI data access, dedicated AI permission gate, sequential-automation privilege caveat, full AI-interaction audit trail | Security/data controls specific to AI surfaces | `/port-ai/security-and-data-controls.md` | 028-ai-agents (gate/privilege caveat) + 015-platform-admin-audit-log (AI-invocation audit) |
| Per-tool approval states, priority hierarchy, pause/resume (`toolApprovals`), interactive tool matcher, regex tool selection | Fine-grained human-in-the-loop tool governance | `/port-ai/tools-and-approvals.md` | 030-ai-assistant |
| AI invocation record entity (reasoning plan, thumbs up/down feedback + API) | Observability of the AI itself | `/port-ai/ai-invocations.md` | 030-ai-assistant |

## 38. Port AI — Skills & prompts

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Skill primitive (name/description/instructions/references/assets, `load_skill`) + built-in skills | Reusable Agent-Skills-spec instruction packages | `/agent-management/ai-registry/skills/overview.md` | 031-ai-registry-skills-and-prompts |
| Custom skills as catalog entities, override-by-name, GitOps ingestion, upload CLI | Org-authored skill lifecycle | `/skills/skills-registry.md` | 031-ai-registry-skills-and-prompts |
| Skills registry (golden path, certification, duplicate detection, ROI scorecard) | Governed catalog of every org skill | same | 031-ai-registry-skills-and-prompts |
| Skills usage analytics (Cursor/Claude Enterprise ingestion) | Real invocation/spend metrics per skill | `/skills-usage-analytics.md` | 031-ai-registry-skills-and-prompts (ingestion) + 035-engineering-intelligence-metrics (dashboard) |
| MCP Prompts (static built-in, custom dynamic/templated, GitOps ingestion, self-service creation, native client surfacing) | Parameterized prompt templates exposed via MCP | `/agent-management/ai-registry/prompts.md` | 031-ai-registry-skills-and-prompts |

## 39. Port AI — MCP connectors, registry & gateway

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| MCP connectors gateway (admin-configured connector catalog, multi-mode auth, per-connector tool allowlisting, secret-reference syntax, tool-name prefixing, usable in workflow AI nodes) | Governed inbound gateway to external MCP servers | `/agent-management/ai-registry/mcp-connectors.md` | 027-mcp-connectors-external |
| MCP registry (`mcpRegistry` blueprint, self-service request/approve flow, "gateway" reuse pattern) | Governance metadata + approval workflow over connectors | `/mcp-registry.md` | 027-mcp-connectors-external |
| Outbound MCP server: role-scoped tool catalogs, concrete ~45-tool inventory, interactive OAuth, machine `client_credentials`, read-only-mode header, action-allowlist header | Tayzu's own MCP-server depth features | `/agent-management/port-mcp-server/*.md` | 026-mcp-server |
| Port AI plugin (curated skill+MCP bundle, one-command install) | Bundled distribution for coding-agent clients | `/port-ai/port-ai-plugin.md` | 031-ai-registry-skills-and-prompts |

## 40. Port AI — Agent registry & AI gateway

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Agent registry blueprint (platform/status/model/region/ownership) + generic registry for unconnected platforms | Cross-platform inventory of every AI agent | `/agent-management/ai-registry/agent-registry.md` | 028-ai-agents |
| Native Claude Managed Agents / Cursor Cloud Agents integrations | First-class sync/control of vendor-hosted agent platforms | `/agent-management/external-agents/*.md` | 028-ai-agents (decision: build vs. skip — see Decisions) |
| Three agent-role framework + self-service lifecycle actions | Governs how agents are created/shared | `/agent-management/overview.md` | 028-ai-agents |
| AI Gateway data ingestion (routing/budgets/guardrails/keys from LiteLLM/Vercel/Bifrost), cost attribution, self-service gateway ops, dynamic budget policies, scorecards on AI infra | Traffic/cost/guardrail governance layer over an existing gateway | `/agent-management/ai-gateway.md` | 032-ai-gateway-governance |

---

## 41. Solutions — Guides & implementation resources

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Guide catalog hub (~170 filterable step-by-step guides) | Public tutorial library for SaaS customers | `/guides.md` | out of scope: public marketing/docs content hub for external customers; not applicable to a private internal tool |
| "Implement in one shot" AI prompts | Copy-pasteable, MCP-runnable build prompts per guide | `/guides/all/*.md` | 031-ai-registry-skills-and-prompts (golden-path skill pattern) |
| "Adapt to your stack" portability notes | Per-guide vendor-swap callouts | same | out of scope: documentation-authoring convention for a public guide library that Tayzu does not build |

## 42. Solutions — Resource management

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Resource Management solution bundle (packaged full-lifecycle self-service) | Named vertical over existing primitives | `/solutions/agentic-resource-management/overview.md` | 036-solutions-resource-management |
| Golden paths + Day-2 operational catalog (scale/patch/restart/decommission/monitor/rotate) | Opinionated, reusable provisioning/ops templates | `/golden-paths.md`, `/common-use-cases.md` | 036-solutions-resource-management |
| Approvals control panel (cross-workflow pending/stalled view) | Aggregate approvals dashboard | `/governance-at-scale.md` | 020-dashboards-and-widgets |
| Platform team hierarchy / nested golden paths | Golden-path inheritance/composition across teams | same | 036-solutions-resource-management |
| Multi-cloud single pane of glass | Normalized resource blueprints across AWS/GCP/Azure + on-prem | `/multi-cloud.md` | out of scope: project.md §1 excludes a multi-cloud resource control plane in Phase 1 (the webhook/custom-integration primitives it would reuse are in 023) |
| Scorecard-triggered auto-remediation | Event-driven golden path fires on a broken rule | `/governance-at-scale.md` | 013-scorecards-integrations-and-groups |

## 43. Solutions — Autonomous Ticket Resolution (ATR)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| ATR 5-stage SDLC pattern (Triage→Plan→Build→Review→Ship) + work-item blueprint (5-stage lifecycle, AI-augmentation taxonomy) | Packaged ticket-to-production flow with human checkpoints | `/solutions/autonomous-ticket-resolution/*.md` | 037-solutions-autonomous-ticket-resolution |
| AI ticket enrichment (PRD + tech spec via a "skill") | Context-grounded requirement generation | `/turn-tickets-into-actionable-work/overview.md` | 037-solutions-autonomous-ticket-resolution (+031 for the skill abstraction) |
| Routing decision (deterministic scorecard gate + AI narrative) | Objective + explained AI-delegation eligibility | `/routing-decision.md` | 012-scorecards-core (gate) + 028-ai-agents (narrative) |
| PR context enrichment, smart reviewer assignment, automated review nudges, security-review finding ingestion | AI-assisted code review support | `/code-review.md` | 037-solutions-autonomous-ticket-resolution (+022 for security-finding ingestion) |
| Blast radius assessment (dependency-graph risk engine) | Pre-production risk analysis from the service graph | `/safe-release.md` | 037-solutions-autonomous-ticket-resolution |
| Deployment readiness scorecards, staged promotion workflows, deployment record writeback | Governed release pipeline | `/safe-release.md` | 012-scorecards-core (scorecards) + 006-workflow-engine-core (promotion/writeback) |
| ATR ROI dashboard | Agent-vs-human split, stage breakdown, stall points | `/roi-dashboard.md` | 035-engineering-intelligence-metrics |
| Agentic initiatives (fleet-wide fan-out with roll-up tracking) | One instruction across every failing service, portfolio counts | `/agentic-initiatives.md` | 037-solutions-autonomous-ticket-resolution (+011 for the aggregation properties it needs) |

## 44. Solutions — Engineering Intelligence

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| EI solution bundle (Business Impact, Delivery, Reliability, Standards, DevEx) + 4-phase maturity rollout | Unified engineering-metrics vertical | `/solutions/engineering-intelligence/*.md` | 035-engineering-intelligence-metrics |
| DORA metrics/scorecards, delivery performance metrics, pipeline reliability metrics, production readiness scorecards | Standard engineering KPIs graded via scorecards | `/measure-and-track-standards/*.md` | 012-scorecards-core (grading) + 035 (metric computation/dashboards) |
| AI coding-tool adoption tracking, AI impact correlation, Claude Skills usage tracking, AI adoption pulse survey | AI-ROI analytics for Tayzu's own dogfooding | `/ai-adoption/*.md` | 035-engineering-intelligence-metrics |
| DevEx/Survey Intelligence plugins (Survey Builder/Forms/Analytics, SPACE/DORA/DX Core 4 templates) | Recurring developer-experience surveys | `/devex-surveys.md` | 035-engineering-intelligence-metrics |
| Conversational insights (in-product agent Q&A, external MCP chat, AI-generated reports) | Natural-language analytics access | `/conversational-insights.md` | 028-ai-agents (in-product) + 026-mcp-server (external) + 030-ai-assistant (generated reports) |
| Breadth of EI data-source integrations (VCS/issue/incident/CI-CD/observability/AI-tools/security/cloud) | How many source categories feed the same catalog | `/overview.md` | 039-integrations-long-tail-backlog (categories beyond dev-tools/security) |

## 45. Solutions — Self-Healing Incidents

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Five-stage framework (Detect→Diagnose→Recommend→Act→Learn) + maturity ladder | Packaged, governed incident-response pattern | `/solutions/self-healing-incidents/*.md` | 038-solutions-self-healing-incidents |
| Detect (multi-signal confidence scoring with decay) | Signal-strength/convergence/persistence scoring | `/detect-incidents.md` | 038-solutions-self-healing-incidents |
| Diagnose (change-event correlation, segmented impact assessment) | Causal-likelihood ranking + cohort severity | `/diagnose-incidents.md` | 038-solutions-self-healing-incidents |
| Recommend (automation eligibility tiering, response scoring) | Gates which action types are even considered, then ranks them | `/recommend-response.md` | 038-solutions-self-healing-incidents |
| Act (approval gate re-checked at execution, scoped per-action identity, gate→execute→verify, human oversight control loop with decision packet) | Dynamic, re-verified autonomous execution | `/act-on-response.md` | 038-solutions-self-healing-incidents |
| Learn (divergence capture, automated tuning proposals) + incident scorecard | Closes the loop from outcome back into thresholds | `/learn-from-incidents.md` | 038-solutions-self-healing-incidents |
| Incident blueprint pattern | Dedicated `incident` entity separate from source alerts | referenced from `overview.md` | 001-catalog-core (generic entity; the packaged pattern is 038) |

## 46. Cross-cutting governance & ops patterns (from guide titles)

| Capability | Summary | Port doc path | Tayzu change |
|---|---|---|---|
| Service lock/unlock (GitHub status-check enforced) | Deployment governance via a status check | `/guides/all/lock-and-unlock-services-in-port.md` | 006-workflow-engine-core (mechanism) + 004-integrations-sdk-core (GitHub status check) |
| Organizational hierarchy views | Models/visualizes org tiers | `/guides/all/create-organizational-hierarchy-views.md` | 001-catalog-core + 003-catalog-ui-core |
| Cross-environment config sync/backup via AI + GitHub MCP | Backup/restore blueprints/actions across environments | `/guides/all/move-port-configurations-*.md` | 033-developer-cli |
| External identity mapping | Cross-system identity reconciliation for ownership/routing | `/guides/all/map-external-users-and-teams-to-port-accounts.md` | 025-sso-and-identity-federation |
| Outbound property sync to external tools (e.g. GitHub custom properties) | Pushes catalog values *out* to a source system | `/guides/all/sync-port-properties-to-github-*.md` | 023-integrations-generic-webhook-and-connector-framework |
| Ocean/integration health monitoring dashboard | Visibility into adapter sync status/performance | `/guides/all/monitor-integrations.md` | 004-integrations-sdk-core (data) + 020-dashboards-and-widgets (dashboard) |
| General self-service Actions ROI dashboard | Non-ATR-specific workflow ROI tracking | `/guides/all/create-roi-dashboard.md` | 035-engineering-intelligence-metrics |

---

## Appendix A — Port native integrations, by category

Every named integration is assigned to a change. "Long-tail" (039) means: build it,
in `039-integrations-long-tail-backlog`, once `023`'s generic connector/webhook
framework exists, prioritized by demand; it is not separately spec'd today.

| Category | Integrations | Tayzu change |
|---|---|---|
| Git providers | **GitHub** | 004-integrations-sdk-core (reference adapter) |
| Git providers | GitLab, Bitbucket Cloud/Server | 039 (long-tail) |
| Git providers | **Azure DevOps** (also CI/CD + PM) | 021-integrations-devops-batch |
| Project management | **Jira Cloud** | 021-integrations-devops-batch |
| Project management | Jira Server, Linear | 039 (long-tail) |
| Code quality & security | **Aikido**, **Orca Security** (webhook), **Escape** (poll), **CodeRabbit** (webhook) | 022-integrations-security-batch |
| Code quality & security | Snyk, Wiz, Mend.io, SonarQube, Checkmarx, ArmorCode, BrowserStack | 039 (long-tail) |
| Cloud providers | AWS (v3, legacy), Azure, GCP | out of scope: project.md §1 defers multi-cloud resource inventory to Phase 2/3 |
| Kubernetes | Kubernetes exporter + ecosystem templates (ArgoCD, Istio, Knative, Kyverno, OpenShift, Trivy, FluxCD) | out of scope: project.md §1 defers a Kubernetes/control-plane integration to Phase 2/3 |
| CI/CD | Jenkins, Octopus Deploy, ArgoCD | 039 (long-tail) |
| APM & alerting | Datadog, Dynatrace, New Relic, Prometheus, Sentry, Azure Monitor | 039 (long-tail) |
| Incident management | PagerDuty, OpsGenie, ServiceNow, FireHydrant, Rootly, Incident.io, Jira Service Management, Statuspage | 039 (long-tail) |
| Cloud cost | Kubecost, OpenCost | 039 (long-tail) |
| Event processing | Kafka (clusters/brokers/topics/consumer groups, as ingested metadata — unrelated to Tayzu's internal queue choice) | 039 (long-tail) |
| Feature management | LaunchDarkly | 039 (long-tail) |
| Identity providers | Okta, Microsoft Entra ID | 025-sso-and-identity-federation (as IdP federation, not catalog ingestion) |
| Automation platforms | n8n, Zapier | 039 (long-tail) |
| AI usage metrics | Claude (Enterprise/Platform), GitHub Copilot, Cursor, OpenAI | 035-engineering-intelligence-metrics |
| Terraform | Terraform Cloud & Enterprise | 039 (long-tail) |
| Other | Amplication, Backstage (migration path), Slack (catalog sync) | 039 (long-tail); Slack's *notification/interaction* role is 034-notifications-and-slack |

## Appendix B — Explicit "out of scope" items and why

| Item | Reason |
|---|---|
| Port MCP server's "no AI terms required" commercial tier | Port-specific legal/commercial product-tier gating; Tayzu is one private product with no separate AI-terms opt-in |
| Multi-organization membership, org switcher, account/company admin tiers, multi-org SSO architecture, default login org | project.md §6 explicitly targets "few known private tenants," not a multi-org-per-user switching UX (recorded as a Decision) |
| Plan-tier lifecycle policy (free-org auto-block/delete) | Port-SaaS billing/plan enforcement; no analogue for a private deployment |
| Formal compliance certifications program (SOC2/ISO/GDPR marketing) | Informational about Port as a vendor; the underlying technical controls (data retention/deletion, MFA) are in scope, the certification program itself is not |
| Private network connectivity (PrivateLink) | Tayzu already runs inside a VNET-integrated ACA environment (project.md §7); no public SaaS ingress to secure |
| Vendor/support impersonation access controls | No third-party vendor-support tier exists for a self-hosted platform |
| Region-specific API base URL (EU/US) | SaaS multi-region routing; Tayzu is a private single-region deployment |
| Cloud provider (AWS/Azure/GCP) & Kubernetes resource inventory integrations | project.md §1 explicitly defers a multi-cloud/multi-cluster control plane to Phase 2/3 |
| Guide catalog hub + "adapt to your stack" documentation convention | Public marketing/tutorial content hub for external SaaS customers; not applicable to a private internal tool |
| Legacy self-service actions / Automations (pre-Workflows) | Deliberately not replicated; Tayzu builds the unified Workflows engine directly (project.md §4) |
