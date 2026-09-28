# Tayzu Phase 1 roadmap proposal — identical functional copy of Port

Source: `port-capability-inventory.md` (this folder), `openspec/project.md` §1-11,
`docs/references/platform-engineering/README.md`, and
`openspec/changes/archive/2026-09-28-001-catalog-core/{proposal,design}.md`. `001-catalog-core`'s
approved scope is unchanged and not widened by this proposal; everything it
explicitly excludes is picked up by a later change below.

39 changes, `001`-`039`. `001-catalog-core` keeps its id and scope exactly as
approved. All other ids are renumbered/split/merged from the current 14-change
roadmap (project.md §11) to fit Port's full breadth at a workable OpenSpec size
(~30-80 TDD tasks each). Ordered by dependency, then by value — small MVP first
(catalog → auth/RBAC → basic UI → GitHub ingestion → workflows), matching the
task's explicit ask and the Platform Engineering reference's "keep 003 thin, put
the effort into 004 and 008" argument (`docs/references/platform-engineering/README.md`
L78).

---

## Roadmap

### Tier 1 — Foundation MVP

#### 001-catalog-core
**Title**: Catalog core (Blueprint/Entity/Relation/Property)
**Scope**: Unchanged from the approved `openspec/changes/archive/2026-09-28-001-catalog-core/proposal.md`:
tenant-scoped Blueprint/Property/Entity/Relation model, `spec`/`status` split, safe
schema evolution, actor-attributed change-event log, oRPC contract (not served over
the network yet).
**Port capabilities covered**: Blueprint JSON schema, essential property types,
string validation, relations (single/many/required), Port Team/User property types
(structurally), meta-properties (timestamps/authorship), protected `_`-prefixed
blueprints (mechanism), manual entity management (API side), generic REST CRUD,
organizational hierarchy views (self-relation), incident blueprint pattern (generic
entity).
**Dependencies**: none.
**Port docs**: `docs.port.io` → Blueprints, Entities, Relations, Properties
(glossary and "Build a software catalog").

#### 002-auth-and-rbac
**Title**: Authentication, RBAC and multi-tenant isolation
**Scope**: Better Auth (`organization`, `admin`, `api-key`, `two-factor` plugins) +
Cerbos policy engine + Postgres RLS under the seam `001` already prepared. Adds:
runtime/migration DB roles and `REVOKE`/`FORCE RLS` (001's T3 follow-up); the
`$team` meta-property and Owning-Teams mechanic; the `ownership` property
(None/Direct/Inherited) with inherited-ownership conflict rules; three-tier RBAC
role baseline; User/Team as core system blueprints with service accounts and a
4-state invitation lifecycle; machine-token vs. human-principal permission
semantics; org API-credentials viewer; data retention/deletion policy and org
deletion; web session timeout policy.
**Port capabilities covered**: blueprint-level entity permissions (baseline),
dynamic ABAC policies, team-based ownership permissions, Owning Teams property,
ownership model, User/Team property types, User/Team system blueprints, three-tier
RBAC, service accounts, per-org user status model, MFA, client-credentials token
exchange, org API credentials UI, data retention & deletion policy, organization
deletion, web session timeout policy, machine-token semantics.
**Dependencies**: 001.
**Port docs**: `docs.port.io` → RBAC/Teams/Roles; `/business-context/ownership.md`;
`/governance/governance-across-pillars/*.md`; `/platform-administration/users-and-teams/*.md`.

#### 003-catalog-ui-core
**Title**: Catalog UI — pages, entity page, search, branding
**Scope**: The thin, API-first UI layer the Platform Engineering reference argues
for: global search (Cmd+K), the default catalog table page and its full UX toolkit
(filters using 005 once it exists, sort, columns, group-by, save view, export,
scale ceiling documentation), the entity page (blueprint-level layout, Overview/
Details widget, auto-populated related-entities tab, manual custom tabs, extra
dashboard tabs), icon library, enum colors, organization branding/announcement
banner, dark/light theme (already committed in project.md §5), and accessibility
conformance.
**Port capabilities covered**: global search, catalog page + its full UX toolkit,
entity page + tabs (excluding Audit Log → 015, Scorecards → 012, visual property
tabs → 011), icon library, enum colors, org branding, announcement banner, custom
icon library, accessibility (WCAG/hotkeys), default User/Team pages and "My"/"My
Teams" filters.
**Dependencies**: 001, 002.
**Port docs**: `docs.port.io/interface-builder/*` (global search, entity page,
customization).

#### 004-integrations-sdk-core
**Title**: Integrations SDK ("Ocean" in TypeScript) + GitHub adapter
**Scope**: The `IntegrationAdapter` framework (poll + webhook → JSONata mapper →
upsert), the mapping engine (resources/selectors, relation-by-search-query,
map-by-property, `itemsToParse`, auto-create/delete flags), sync mechanics (full
resync with reconciliation, incremental sync, live events on BullMQ+Redis,
sync-interaction rules, "apply mapping"), per-integration monitoring/sync-status,
reusable declarative custom-auth (OAuth2/JWT), and the GitHub adapter itself
(including its depth features: repo search selection, archived-repo exclusion,
multi-org, file/README/CODEOWNERS enrichment, `file`-kind ingestion, monorepo
mapping, GitHub-status-check enforcement for service lock/unlock).
**Port capabilities covered**: Ocean SDK, mapping engine (all sub-items), sync
mechanisms (full/incremental/live-events/interactions/apply-mapping),
per-integration monitoring, custom-auth, GitHub native integration + depth
features, CI/CD reporter pattern (GitHub side), service lock/unlock mechanism.
**Dependencies**: 001, 002.
**Port docs**: `docs.port.io/build-your-software-catalog/sync-data-to-catalog/`
(index), `ocean.port.io`, `github.com/port-labs/ocean` (source), git integration
pages under `/native-integrations/available-integrations/git.md`.
**Reordering vs. current roadmap**: moved from project.md's old `008-integrations-sdk` to right after basic UI,
per the Platform Engineering reference's explicit tension note (README, "moving
the GitHub adapter and MCP earlier") and this task's own requested MVP order.

### Tier 2 — Workflows

#### 005-search-and-query
**Title**: Unified search & query engine
**Scope**: The cross-cutting query DSL (`combinator`/`rules`, nested groups, no
short-circuit), the full comparison-operator set, relation operators (`relatedTo`,
`matchAny` with `path`/`maxHops`), contextual query rules (`context: user`/
`userTeams`), and the API tuning params. This single primitive backs catalog
filtering, dashboards, scorecard filters, dynamic RBAC policies, aggregation
properties, and self-service dataset filters — Port's single largest cross-cutting
capability with no Tayzu equivalent today.
**Port capabilities covered**: unified search/query DSL, all comparison/relation
operators, contextual query rules, filter-by-relation/scorecard, search API tuning
params, `maxHops` self-relation traversal, `.user.*` dynamic-rule context.
**Dependencies**: 001, 002, 003.
**Port docs**: `/context-lake/consuming-the-lake/search-and-query/*.md`.

#### 006-workflow-engine-core
**Title**: Workflow graph engine (unified triggers/actions/conditions/input)
**Scope**: The unified directed-graph engine project.md §4 already commits to,
built directly (no legacy actions/automations split): trigger/action/condition/
input node types, multiple triggers per workflow, optimistic-concurrency editing,
reusable/child workflows, action-run-as-trigger, data-flow (`.outputs`, run-context
variables), the org-level secrets store, webhook signature verification, and the
static+dynamic execute-permission model per trigger (backed by 002/005).
**Port capabilities covered**: workflow graph model and metadata, all four trigger
kinds, webhook/upsert-entity/integration action nodes (generic contract), Input
node (human-in-the-loop gate), condition node, `variables`, `.outputs`/run-context
templating, org secrets store, workflow permissions (static+dynamic), reusable
workflows, optimistic concurrency, trigger publish/unpublish, action-run-as-trigger.
**Dependencies**: 001, 002, 005.
**Port docs**: `docs.port.io/workflows/overview`, `/workflows/concepts.md`,
`/workflows/build-workflows/*` — read in full before touching the engine
(project.md §19 flags this as the newest, most load-bearing Port documentation).

#### 007-workflow-runs-and-execution
**Title**: Workflow run management & execution observability
**Scope**: The `WorkflowRun`/node-run data model's operational surface: the
node-run reporting API (external backends `PATCH` status/output, `POST` logs),
cancel (graceful/force), full-run log viewer, re-run with the same inputs
(building on 001's already-designed partial re-run), tying arbitrary entity
mutations to a `run_id`, node-level `links`/`verbose` logging, and condition
outlet status labels.
**Port capabilities covered**: node-run reporting API, run cancellation, full-run
log viewer, re-run with same inputs, `run_id` entity tagging, node-level
links/verbose, outlet status labels, entity-page Runs-tab data.
**Dependencies**: 006.
**Port docs**: `/workflows/track-workflow-execution/*.md`,
`/workflows/actions-and-automations/reflect-action-progress.md`.

#### 008-workflow-canvas
**Title**: Visual workflow canvas (React Flow) + JSON editor
**Scope**: The visual graph editor and raw-JSON editor as two views of the same
graph (project.md §4/§5), a test-run mode (mocked node outputs, single-node +
ancestors execution), and the visual run-replay page with live per-node status
overlay and per-node run detail panel, built on 007's run data.
**Port capabilities covered**: visual editor, raw JSON editor, test-run a draft
(mocked outputs, single-node execution), visual run-replay page, per-node run
detail panel.
**Dependencies**: 006, 007.
**Port docs**: `/workflows/build-workflows/quickstart.md`, `/test-workflows.md`,
`/track-workflow-execution/workflow-run-page.md`; Backstage's "Catalog Graph" UX
as the reference pattern (project.md §5).

#### 009-workflow-ai-authoring
**Title**: AI-assisted workflow authoring
**Scope**: The propose-as-diff → review → apply conversational authoring flow
(project.md §4), reusing the OpenSpec diff-review UI pattern; AI action node's
inline tool/MCP-connector scoping and structured-output contract live here as the
authoring-time concern (their runtime execution is 030).
**Port capabilities covered**: AI-assisted natural-language builder.
**Dependencies**: 006, 008.
**Port docs**: `/workflows/build-workflows/quickstart.md`,
`port.io/blog/port-workflows`.

#### 010-workflow-self-service-forms
**Title**: Self-service form depth (inputs, encryption, multi-step)
**Scope**: Everything project.md's react-hook-form+Zod generator doesn't yet cover:
dependent/dynamic defaults, conditional visibility/disabled, JQ/JSONata-equivalent
validation rules (backed by 005), multi-step forms, entity-input dataset filters,
input ordering, the secret input type (server-managed AES-256-GCM or BYO
RSA-hybrid client-side encryption — flagged as a real, non-trivial gap in the
source inventory), setup checklist for missing integrations/secrets, deferred
integration installation, "create entity" and entity-bolt trigger contexts, custom
trigger button text, and shareable pre-filled workflow URLs.
**Port capabilities covered**: all self-service-form advanced-input
configurations, secret input type, multi-step forms, dataset filters, input
ordering, setup checklist, deferred integration install, trigger contexts, custom
button text, shareable URLs.
**Dependencies**: 005, 006.
**Port docs**: `/workflows/build-workflows/self-service-trigger/*.md`,
`/actions-and-automations/create-self-service-experiences/setup-ui-for-action/*.md`.

### Tier 3 — Catalog depth, scorecards, governance

#### 011-catalog-advanced-properties
**Title**: Advanced property types (mirror, calculation, aggregation, timer, embeds)
**Scope**: Every property type `001` deliberately excluded: mirror, calculation
(JSONata-based per ADR-0002, including the persistent/background-computed
variant), aggregation (by-entities and by-property, with path filter — this is the
type Port's own "Agentic Initiatives" fleet-tracking pattern depends on), timer
(TTL, `TIMER_EXPIRED` event), embedded URL (public + SSO/PKCE), Swagger/OpenAPI,
Markdown, and the remaining string sub-formats (Proto/Email/YAML) and labeled-URL
object. Ships as a schema-compatible extension of `001`'s property subset (ADR-0008),
never widening the frozen 001 contract.
**Port capabilities covered**: mirror, calculation, persistent calculation,
aggregation (+ path filter), timer, embedded URL, Swagger UI, markdown property,
string sub-formats, labeled URL, entity-page auto-generated visual property tabs.
**Dependencies**: 001, 005 (aggregation needs the query engine), 006 (timer's
`TIMER_EXPIRED` needs the event trigger).
**Port docs**: `/context-lake/data-model/setup-blueprint/properties/*.md`.

#### 012-scorecards-core
**Title**: Scorecards core (rules, levels, entity tab, basic dashboard)
**Scope**: The rules+levels grading engine (`Basic` → advance only when every rule
at a level passes), the rule condition language and scorecard filters (via 005),
Scorecard/Rule/RuleResult as protected extensible system blueprints, scale/async
design for large rule-result sets, manage-scorecards UI/API, and the entity-page
Scorecards tab.
**Port capabilities covered**: scorecard core model, rule condition language,
scorecard filters, protected scorecard blueprints, scale limits, scorecard
views/entity tab, manage scorecards (UI/API), scorecard-as-AI-dispatch-guardrail
(gate), deployment-readiness scorecards.
**Dependencies**: 001, 003, 005.
**Port docs**: `docs.port.io` → Scorecards; `/governance/standards-and-compliance/
concepts-and-structure.md`, `/manage-scorecards.md`.

#### 013-scorecards-integrations-and-groups
**Title**: Scorecard groups & third-party compliance automation
**Scope**: Scorecard Groups (one rule set applied across many blueprints, shared
or per-blueprint rule modes, aggregated cross-blueprint reporting), the SLA
extension pattern (due-date property + reminder/escalation), generic
rule-result-triggered notifications (webhook/email), and wiring the event
trigger's `impactedEntity` enrichment for `_rule_result` so any later consumer
(including `021`'s Jira/GitHub action nodes) can subscribe to a rule violation.
Jira/GitHub issue automation on rule violation is deliberately *not* built here —
see `021` — because it needs adapters this change has no dependency on.
**Port capabilities covered**: Scorecard Groups, SLA extension pattern, generic
rule-result notifications, rule-result trigger enrichment.
**Dependencies**: 006, 012.
**Port docs**: `/governance/standards-and-compliance/manage-scorecard-groups.md`,
`/examples/extend-data-model.md`.

#### 014-governance-and-policy-simulation
**Title**: Permission simulator, page ACLs & cross-pillar policy depth
**Scope**: The permission simulator ("why can user X do Y", blast-radius check),
property-level read/update restrictions, global-vs-granular precedence, natural
language policy authoring (calls into 030), "view as" a different user, per-page
view/edit ACLs (with PATCH-partial semantics and page locking) applied identically
to AI agents, the workflow edit-vs-run permission split, execution-source-aware
policy (block MCP-triggered runs), and "trigger on behalf of"/run-visibility
toggles.
**Port capabilities covered**: permission simulator, property-level restrictions,
permission precedence, NL policy authoring (hook), "view as" user, page
permissions (ACL/PATCH/lock), workflow dual-layer permissions,
execution-source-aware policy, `run_as`, run-visibility toggle, cross-pillar
governance consistency.
**Dependencies**: 002, 003, 005, 006.
**Port docs**: `/governance/governance-across-pillars/*.md`,
`/context-lake/consuming-the-lake/govern-data-access/*.md`,
`/interface-builder/port-interface/page/page-permissions.md`.

#### 015-platform-admin-audit-log
**Title**: Organization-wide audit log & usage analytics
**Scope**: A compliance-grade, org-wide audit log UI distinct from OTel traces
(every create/update/delete across entities, blueprints, workflows, scorecards,
integrations, secrets), diff view, source-type attribution, retention + API
access, non-admin self-service run history ("My inbox"), AI-agent run
auditability, the AI-invocation audit entity, and the portal usage dashboard
(5 tabs: user activity, entities, workflows, data sources, AI/MCP).
**Port capabilities covered**: organization-wide audit log, diff view, source
attribution, retention+API, self-service run history, AI-agent run auditability,
AI-interaction audit trail, portal usage dashboard.
**Dependencies**: 001, 002, 006.
**Port docs**: `/platform-administration/audit-log.md`, `/usage-dashboard.md`,
`/port-ai/security-and-data-controls.md`, `/port-ai/ai-invocations.md`.

### Tier 4 — Observability, docs, plugins

#### 016-observability-dogfood
**Title**: Observability dogfood (Service/Deployment + full default blueprints)
**Scope**: Unchanged in spirit from project.md's old `010-observability-dogfood`: Service/Deployment blueprints and
OTel end-to-end tracing over Tayzu's own project, extended to the full Port
default-blueprint set (`environment`, `workload`), SLO targets and error-budget
alerts on `001`'s `operation.duration` (T5b), and DORA-ready blueprint shape.
**Port capabilities covered**: default blueprints (service/environment/workload/
deployment), SLOs/error-budget alerts, DORA-ready blueprint shape.
**Dependencies**: 001.
**Port docs**: n/a (Tayzu-specific dogfooding); see
`docs/references/platform-engineering/observability-for-platform-engineers.md`.

#### 017-docs-as-catalog-entities
**Title**: Docs as catalog entities
**Scope**: Unchanged from project.md's old `011-docs-as-catalog-entities` — versioned documentation stored and rendered
inside Tayzu with no external runtime dependency, plus a "search Tayzu docs" MCP
tool consumed by 026.
**Port capabilities covered**: none directly (Port has no equivalent — this is a
Tayzu differentiator, per project.md §11's own note); provides the docs-search
tool 026 needs.
**Dependencies**: 001, 003.
**Port docs**: none (deliberately building ahead of Port here).

#### 018-plugins-sandbox
**Title**: Plugin sandbox (postMessage, single-HTML artifact)
**Scope**: Unchanged from project.md's old `012-plugins-sandbox`: the plugin packaging model
(`vite-plugin-singlefile` → one `dist/index.html`), the postMessage protocol
(`PORT_TOKEN`/`PLUGIN_DATA` in, dialog/AI-chat bridge calls out), concrete CSP
directives, size/format limits, and the packaged SDK host-bridge helpers.
**Port capabilities covered**: plugin packaging, postMessage protocol, CSP,
size/format limits, plugins SDK helpers.
**Dependencies**: 003.
**Port docs**: `/interface-builder/port-interface/plugins.md`,
`/customize-pages-dashboards-and-plugins/plugins/*.md`, `port-plugin-sample` repo.

#### 019-plugins-marketplace-and-cli
**Title**: Plugins CLI, marketplace & management API
**Scope**: The tooling around the sandbox mechanism: the plugins CLI
(`config`/`upload`/`list`/`delete`), a curated plugins library/marketplace, the
Plugins Manager admin screen, typed custom-widget parameters, and the plugin CRUD
REST API.
**Port capabilities covered**: plugins CLI, plugins library, Plugins Manager,
custom-widget parameters, plugin CRUD API.
**Dependencies**: 018.
**Port docs**: `/interface-builder/port-interface/plugins.md`.

### Tier 5 — Dashboards & remaining integrations

#### 020-dashboards-and-widgets
**Title**: Dashboard pages & widget system
**Scope**: The single biggest structural gap identified in the source inventory:
a freeform dashboard-page type (grid of widgets, add/reorder/resize, duplicate,
cross-widget filters), the full data-widget set (number/pie/bar/line/multi-line
chart, table, entity-card, drill-down), personal widgets, custom widgets (iframe,
markdown, links, workflow-card, action-history, plugin-container — depends on
018), folders and private pages, the ownership-management dashboard recipe, the
approvals control panel, hierarchy-aware dashboard views, and the embeddable
workflow-runs-history widget. The AI Agent chat widget and AI-generated
onboarding dashboards are stretch tasks that land once 028/030 exist.
**Port capabilities covered**: dashboard pages, all data/personal/custom widgets,
folders, private pages, dashboard filters, ownership dashboard recipe, approvals
control panel, workflow-runs-history widget, AI-generated dashboards (fast-follow).
**Dependencies**: 003, 005, 007, 018.
**Port docs**: `/interface-builder/port-interface/page/dashboard-page.md`,
`/dashboards/{data-widgets,custom-widgets,personal-widgets}.md`,
`/page/{folders,private-pages}.md`.

#### 021-integrations-devops-batch
**Title**: Integrations batch — Jira Cloud & Azure DevOps
**Scope**: Two more adapters on the `004` framework: Jira Cloud (catalog sync +
workflow action node for issue create/status-change) and Azure DevOps (pipeline
sync + self-service pipeline dispatch), matching project.md §8's priority list.
Also closes the loop `013` deliberately left open: Jira/GitHub issue automation
on scorecard rule violation, wiring `013`'s already-built `_rule_result`
event-trigger enrichment to this change's own Jira/GitHub action nodes.
**Port capabilities covered**: Jira Cloud native integration + workflow action
node, Azure DevOps native integration + pipeline backend, user/team identity sync
from these sources, Jira/GitHub issue automation on scorecard rule violation.
**Dependencies**: 004, 006, 013.
**Port docs**: `/native-integrations/available-integrations/project-management.md`,
Azure DevOps pages under the same index; `ocean.port.io`.

#### 022-integrations-security-batch
**Title**: Integrations batch — security & code-quality tools
**Scope**: Aikido (poll+webhook, shared pattern), Orca Security (inbound webhook,
`orcaSecurityAlert` blueprint), Escape (poll to `public.escape.tech/v3`),
CodeRabbit (webhook on PR-review-comment events, plus ingesting Claude Code's own
`/security-review` findings for a searchable audit trail). Orca's and
CodeRabbit's inbound webhooks are hard-coded adapters built directly on `004`'s
`IntegrationAdapter` poll/webhook contract — they do not need `023`'s no-code
generic connector, so this change has no dependency on it.
**Port capabilities covered**: Aikido/Orca/Escape/CodeRabbit native integrations,
security-review finding ingestion.
**Dependencies**: 004.
**Port docs**: `docs.port.io/guides/all/ingest-vulnerability-alerts-from-orca-
security-using-a-custom-webhook-integration`; `docs.escape.tech`;
`docs.coderabbit.ai`.

#### 023-integrations-generic-webhook-and-connector-framework
**Title**: Generic webhook connector & no-code integration framework
**Scope**: The reusable, self-serve pieces that make every future adapter cheaper
— deliberately scoped to just the framework, not the adapters it will host (that
long tail is `039`, split out because bundling ~40 unrelated integration
categories into the same change as the framework they depend on made this the
single largest, least cohesive change in the roadmap): the generic
JQ/JSONata-mapped webhook connector (signature verification, async
`202`-accepted processing, `itemsToParse` batching), the no-code "Ocean custom"
REST-connector builder (auth types, pagination styles, nested endpoints), the
mapping test playground, `port.yml`-style GitOps ingestion, S3/ELT-mediated
ingestion, multi-source ingestion (relations/array properties/ownership), and
outbound property sync.
**Port capabilities covered**: generic webhook connector + security config,
no-code REST connector, mapping playground, GitOps ingestion, S3 ingestion,
multi-source ingestion, outbound property sync.
**Dependencies**: 004.
**Port docs**: `/ingestion/ingest-data-into-port/webhook/*.md`,
`/custom-integration/ocean-custom-integration/*.md`,
`/other/gitops.md`, `/other/s3-integrations.md`.

#### 024-catalog-data-lifecycle
**Title**: Catalog data lifecycle — migration, cleanup, export, IaC
**Scope**: Immutable-property-type + Migrate Blueprint Data (bulk JQ/JSONata
remap, dry-run, partial-failure reporting), guided stale-entity cleanup (bulk
delete, export-before-delete), catalog data export (JSON/GitOps YAML/Terraform
HCL), AI-powered catalog auto-discovery (suggest + review/approve missing
entities), webhook/permission/scorecard/entity-page management-via-IaC, and
config-as-code rollout with review gates across environments. Resolves the IaC
question from Decisions below with an export/import-first approach.
**Port capabilities covered**: migrate-blueprint-data, stale-entity cleanup,
catalog export, catalog auto-discovery, IaC for blueprints/permissions/
scorecards/pages/workflows, config-as-code environment promotion.
**Dependencies**: 001, 005, 012, 020.
**Port docs**: `/ingestion/ingest-data-into-port/other/migrate-data.md`,
`/configure-mapping/entity-cleanup.md`, `/ingestion/catalog-auto-discovery.md`,
`/data-model/iac/*.md`, `/platform-administration/multi-org-management/
manage-port-across-environments.md`.

#### 025-sso-and-identity-federation
**Title**: Enterprise SSO & identity federation
**Scope**: Generic OIDC and SAML 2.0 protocol support, pre-built connectors
(Okta, Entra ID, Google Workspace, OneLogin, JumpCloud), LDAP, SCIM provisioning,
group-sync regex filters, session controls, company-domain verification, and
per-tenant automatic user access — all scoped to Tayzu's single-tenant-per-org
model (no multi-org SSO architecture; see Decisions).
**Port capabilities covered**: self-serve SSO wizard, SAML, OIDC, pre-built SSO
connectors, LDAP, SCIM, group-sync filters, session controls, domain
verification, automatic user access, external identity mapping.
**Dependencies**: 002.
**Port docs**: `/platform-administration/sso-authentication/*.md`.

### Tier 6 — MCP & AI

#### 026-mcp-server
**Title**: MCP server (outward tool gateway)
**Scope**: Unchanged in spirit from project.md's old `013-mcp-server`: wraps oRPC procedures and
workflow triggers as MCP tools (`list_self_service_triggers`, `trigger_run`,
catalog CRUD, scorecards, pages/dashboards, plugins, integrations inspection,
audit-log search, docs search), role-scoped tool catalogs (Developer vs.
Builder), interactive OAuth for IDE clients, machine `client_credentials` auth,
the read-only-mode header, and the action-allowlist header. No path exists that
only MCP can use (the "same governed path" principle, project.md §1).
**Port capabilities covered**: outward MCP server, tool catalog, role-scoped
tools, OAuth/machine auth, read-only/allowlist headers, tool-description-as-
agent-instructions convention, CI/CD token auth for MCP, plugin management via
MCP.
**Dependencies**: 001, 002, 006, 012, 017, 018.
**Port docs**: `docs.port.io/port-ai/*` (the MCP server and its tools).

#### 027-mcp-connectors-external
**Title**: MCP connectors — governed gateway to external MCP servers
**Scope**: The opposite direction from 026: an admin-configured connector catalog
for external MCP servers (Notion, Slack, GitHub, custom), multiple auth modes
(dynamic client registration, manual OAuth, API-key, no-auth), per-connector tool
allowlisting, tool-name prefixing, secret-reference syntax, usage from workflow
AI nodes, and the MCP registry (approval-status blueprint + self-service
"request new MCP server" flow).
**Port capabilities covered**: MCP connectors gateway, MCP registry, "consume an
external MCP server" ingestion family.
**Dependencies**: 002, 006.
**Port docs**: `/agent-management/ai-registry/mcp-connectors*.md`,
`/mcp-registry.md`, `/context-lake/ingestion/integrations-vs-mcp.md`.

#### 028-ai-agents
**Title**: AI agents (governed, catalog-native)
**Scope**: Unchanged in spirit from project.md's old `014-ai-agents`: agents governed by Cerbos, the
same execution path and audit trail as a human, the four control modes
(assistive/task/workflow/bounded autonomy), the agent registry blueprint, the
dedicated `_ai_invocation`-style permission gate, the AI action node's "invoke
named agent" path, the routing-decision AI narrative pattern, and — as an
explicit decision item — whether to build outbound orchestration nodes for
Claude Managed Agents / Cursor Cloud Agents (see Decisions).
**Port capabilities covered**: agents-over-the-catalog, agent registry, AI action
node (named-agent path), scorecard-as-dispatch-guardrail consumption,
conversational-insights (in-product), ontology-quality consumption,
external-agent orchestration nodes (decision).
**Dependencies**: 001, 002, 006, 026.
**Port docs**: `docs.port.io/port-ai/*` — Context Lake and AI Agents;
`/agent-management/ai-registry/agent-registry.md`,
`/agent-management/external-agents/*.md`.

#### 029-ai-registry-llm-providers
**Title**: AI registry — LLM provider abstraction (BYOL)
**Scope**: Generalizes project.md §2's `DecisionProvider` interface into a real
multi-provider registry: bring-your-own-LLM for OpenAI/Anthropic/Azure/Bedrock/
Vertex/OpenAI-compatible, per-request provider/model override, model-subset
enablement, connection validation, org-level default config, provider-secret
storage (Key Vault-backed), and the rate-limit/quota/tool-call/response-length
circuit breakers the source inventory flags as worth having independent of
billing.
**Port capabilities covered**: BYOL provider registry, per-request override,
model overrides, connection validation, org default provider, provider secrets,
rate limits/quotas/caps.
**Dependencies**: 002.
**Port docs**: `/port-ai/llm-providers-management/*.md`,
`/port-ai/limits-and-quotas.md`.

#### 030-ai-assistant
**Title**: General AI assistant (chat, invoke API, tool approvals)
**Scope**: The general-purpose, MCP-client-orchestrating assistant distinct from
a task agent: no-config chat UI with ask/plan/build modes, the
`/v1/ai/invoke`-equivalent general API with SSE streaming and request-level
controls, structured output as a general feature (not just the `DecisionProvider`
path), per-tool approval states/priority/pause-resume, the AI-invocation
record (reasoning plan + feedback), the docs-only "Ask AI" copilot, and
conversational dashboard/widget/report authoring.
**Port capabilities covered**: Port AI base engine, no-config assistant,
ask/plan/build modes, invoke API + SSE, structured output (general), tool
approvals, AI invocation record, docs AI assistant, AI-generated
dashboards/reports, NL blueprint/policy authoring (surface).
**Dependencies**: 001, 002, 003, 006, 017, 026, 029.
**Port docs**: `/port-ai/overview.md`, `/port-ai/port-ai-assistant.md`,
`/port-ai/api-interaction.md`, `/port-ai/tools-and-approvals.md`,
`/port-ai/ai-invocations.md`.

#### 031-ai-registry-skills-and-prompts
**Title**: AI registry — Skills & Prompts primitives
**Scope**: The Skill primitive that the source inventory calls "a missing
*primitive*, not just a missing feature": built-in + custom skills, the skills
registry (certification, duplicate detection, ROI scorecard, golden path for
shipping new skills), GitOps skill ingestion, the skills upload CLI, skills usage
analytics; the MCP Prompts primitive (static, custom dynamic/templated, GitOps
ingestion, self-service creation); and a bundled skill+MCP distribution
equivalent to the "Port AI plugin".
**Port capabilities covered**: Skills (entire), MCP Prompts (entire), Port AI
plugin bundle, `load_skill` tool, Agent Skills/Plugins/MCP-server discovery from
repos, "implement in one shot" golden-path prompts.
**Dependencies**: 004, 017, 026.
**Port docs**: `/agent-management/ai-registry/skills/*.md`,
`/agent-management/ai-registry/prompts.md`, `/port-ai/port-ai-plugin.md`.

#### 032-ai-gateway-governance
**Title**: AI Gateway governance
**Scope**: Lower-priority, later-value capability: ingest traffic/budget/
guardrail/key data from an existing external gateway (LiteLLM, Vercel AI
Gateway, Bifrost), cost/ownership attribution via catalog relations, self-service
gateway operations (issue key, request budget, test guardrail) as governed
workflows, dynamic budget/tool-access policies, and scorecards applied to AI
infrastructure (agents/guardrails/keys).
**Port capabilities covered**: AI Gateway data ingestion, cost attribution,
self-service gateway ops, dynamic budget policies, scorecards on AI infra.
**Dependencies**: 006, 012, 028, 029.
**Port docs**: `/agent-management/ai-gateway.md`.

### Tier 7 — Developer tooling, packaged solutions & integration backlog

#### 033-developer-cli
**Title**: Tayzu CLI (Go)
**Scope**: The Go CLI project.md §2 names but never scopes: raw-JSON, scriptable,
pipeable shell client for humans and agents; client-credentials or interactive
login; org export/import/compare/migrate/backup for cross-environment promotion.
**Port capabilities covered**: Port CLI, cross-environment config sync/backup.
**Dependencies**: 001, 002, 024.
**Port docs**: `/port-ai/interfaces/port-cli.md`.

#### 034-notifications-and-slack
**Title**: Slack notification & interaction channel
**Scope**: Decision-gated (see Decisions): if approved, a Slack app (workspace
install, per-user OAuth-linked identity preserving RBAC), dynamic multi-channel
routing, channel-name enrichment, `@Tayzu` mentions/slash command/DMs,
interactive Slack forms for the workflow Input node, Slack-native scorecard
compliance messaging, and a dedicated Slack backend for workflow actions.
**Port capabilities covered**: Slack app (entire), Slack compliance messaging,
Input-node Slack responses, Send-Slack-message backend.
**Dependencies**: 006, 025.
**Port docs**: `/interface-builder/notifications/slack-app.md`,
`/governance/standards-and-compliance/manage-using-3rd-party-apps/slack.md`.

#### 035-engineering-intelligence-metrics
**Title**: Engineering Intelligence & DORA metrics
**Scope**: DORA/delivery-performance/pipeline-reliability metric computation on
top of `012`'s grading engine, the 4-phase EI maturity rollout, AI coding-tool
adoption tracking (Claude/Copilot/Cursor usage/cost/skill-adoption — genuinely
useful for Tayzu's own dogfooding), AI-impact correlation, DevEx/Survey
Intelligence (SPACE/DORA/DX Core 4 templates), and the general and ATR-specific
ROI dashboards.
**Port capabilities covered**: DORA/delivery/reliability metrics+scorecards, EI
solution bundle, EI maturity rollout, AI-adoption tracking, AI-impact
correlation, Claude Skills usage dashboard, DevEx surveys, ROI dashboards.
**Dependencies**: 004, 012, 020, 021, 022, 031.
**Port docs**: `/solutions/engineering-intelligence/*.md`.

#### 036-solutions-resource-management
**Title**: Resource Management golden paths (packaged solution)
**Scope**: The packaged vertical over existing primitives: a golden-path
template library, the Day-2 operational catalog (scale/patch/restart/decommission/
monitor/rotate), platform-team hierarchy / nested golden paths, and the
out-of-the-box ownership self-service actions.
**Port capabilities covered**: Resource Management bundle, golden paths, Day-2
catalog, platform-team hierarchy, ownership self-service actions.
**Dependencies**: 006, 010, 021.
**Port docs**: `/solutions/agentic-resource-management/*.md`.

#### 037-solutions-autonomous-ticket-resolution
**Title**: Autonomous Ticket Resolution (packaged solution)
**Scope**: The 5-stage ATR pattern (Triage→Plan→Build→Review→Ship), the work-item
blueprint pattern, PR context enrichment, smart reviewer assignment, automated
review nudges, the blast-radius/dependency-graph risk engine (a genuinely new
primitive, not covered elsewhere), staged promotion + deployment-record
writeback, agentic initiatives (fleet-wide fan-out), and the ATR ROI dashboard
(delegated to 035).
**Port capabilities covered**: ATR bundle, work-item blueprint, PR enrichment,
reviewer assignment, blast-radius assessment, agentic initiatives.
**Dependencies**: 001, 004, 006, 011, 012, 022, 028.
**Port docs**: `/solutions/autonomous-ticket-resolution/*.md`.

#### 038-solutions-self-healing-incidents
**Title**: Self-Healing Incidents (packaged solution)
**Scope**: The most sophisticated, newest framework in the source material — a
5-stage Detect→Diagnose→Recommend→Act→Learn pattern with confidence scoring and
decay, causal-likelihood ranking, an approval gate re-checked at execution time,
scoped per-action credential issuance, a human-oversight control loop with a
"decision packet," and a divergence-capture learning loop. Recommended as the
last change in Phase 1 given its size and the number of primitives it composes;
see Decisions for a build-now-vs-defer call.
**Port capabilities covered**: the entire five-stage framework, incident
maturity model, incident scorecard.
**Dependencies**: 001, 006, 012, 028, 037.
**Port docs**: `/solutions/self-healing-incidents/*.md`.

#### 039-integrations-long-tail-backlog
**Title**: Long-tail native-integration backlog
**Scope**: Split out of the old `023` (see that change's note): every remaining
native-integration category from Appendix A of `port-capability-inventory.md`,
built opportunistically on `023`'s connector framework as demand arises, not
separately spec'd today — GitLab/Bitbucket (git), Jira Server/Linear (project
mgmt), the remaining code-quality/security tools (Snyk, Wiz, Mend.io, SonarQube,
Checkmarx, ArmorCode, BrowserStack), CI/CD (Jenkins, Octopus Deploy, ArgoCD) incl.
their workflow backends, APM/alerting, incident management, cloud cost, Kafka
(as ingested metadata), feature flags, automation platforms (n8n, Zapier — incl.
the n8n custom-node consumption pattern), Terraform Cloud, and the remaining
"other" category (Amplication, Backstage, Slack catalog sync). Nothing else in
the Phase 1 roadmap depends on this change, which is why it can sit last without
creating a dependency-order problem.
**Port capabilities covered**: long-tail adapters (GitLab, Bitbucket, Jira
Server, Linear, Jenkins, Octopus Deploy, ArgoCD, APM/alerting, incident mgmt,
cloud cost, Kafka metadata, feature flags, automation platforms, Terraform
Cloud, Amplication/Backstage/Slack-catalog-sync), GitLab/Jenkins/Terraform-Cloud
workflow backends, remaining CI/CD reporter integrations (GitLab CI, Jenkins,
CircleCI, Codefresh), n8n custom-node consumption pattern.
**Dependencies**: 004, 023.
**Port docs**: `/native-integrations/available-integrations/*.md` (full index),
`/other-consumption-methods/port-n8n-node.md`, `/setup-backend/*.md`.

---

## Mapping table — old id(s) → new id(s)

| Old id (project.md §11) | New id(s) | What moved |
|---|---|---|
| `001-catalog-core` | `001-catalog-core` | Unchanged, verbatim. |
| `002-auth-and-rbac` | `002-auth-and-rbac` | Same core scope; absorbs ownership model, `$team`, service accounts, user lifecycle, data retention. |
| `003-catalog-ui` | `003-catalog-ui-core` | Narrowed to pages/entity page/search/branding; dashboards split out to `020`; page ACLs to `014`; export to `024`. |
| `004-workflow-engine-core` | `006-workflow-engine-core` | Same core graph model; run management split to `007`; self-service depth split to `010`. |
| `005-workflow-canvas` | `008-workflow-canvas` | Unchanged scope, renumbered; gains test-run + run-replay. |
| `006-workflow-ai-authoring` | `009-workflow-ai-authoring` | Unchanged scope, renumbered. |
| `007-scorecards` | `012-scorecards-core` + `013-scorecards-integrations-and-groups` | Core grading engine vs. groups/3rd-party automation split out. |
| `008-integrations-sdk` | `004-integrations-sdk-core` (GitHub only) + `021-integrations-devops-batch` (Jira/ADO) | GitHub moved earlier per the Platform Engineering reference; Jira/ADO deferred as their own batch. |
| `009-integrations-security-tools` | `022-integrations-security-batch` | Unchanged scope, renumbered; gains security-review finding ingestion. |
| `010-observability-dogfood` | `016-observability-dogfood` | Unchanged scope, renumbered; gains full default-blueprint set + SLOs. |
| `011-docs-as-catalog-entities` | `017-docs-as-catalog-entities` | Unchanged scope, renumbered; gains a docs-search MCP tool. |
| `012-plugins-sandbox` | `018-plugins-sandbox` + `019-plugins-marketplace-and-cli` | Core sandbox vs. CLI/marketplace/management-API split out. |
| `013-mcp-server` | `026-mcp-server` | Unchanged scope, renumbered; gains role-scoped tools, headers, machine auth depth. |
| `014-ai-agents` | `028-ai-agents` | Unchanged scope, renumbered; gains agent registry + external-agent-node decision. |
| *(none — new)* | `005, 007, 010, 011, 014, 015, 020, 023, 024, 025, 027, 029, 030, 031, 032, 033, 034, 035, 036, 037, 038, 039` | 22 wholly new changes, see table above; `039` is `023` split in two (see Critic review). |

---

## Coverage check

Every GAP/PARTIAL row from the seven source inventories' own "Gaps summary"
sections is assigned to a change id or an explicit "out of scope" entry in
`port-capability-inventory.md` (Appendix B). Per-file counts (from each file's own
`## Gaps summary` section, GAP + PARTIAL combined):

| Source file | GAP+PARTIAL items | Assigned to a change | Assigned "out of scope" (reasoned) |
|---|---|---|---|
| `inv-context-lake-model.md` | 38 | 36 | 2 (MCP "no AI terms" tier; n8n node folded into long-tail instead — 0 truly unassigned) |
| `inv-context-lake-ingestion.md` | 22 | 21 | 1 (Kubernetes GitOps CRDs) |
| `inv-workflows.md` | 55 | 52 | 3 (Port execution agent; static outbound-IP allowlisting — infra decision, not a change; Kafka action/backend — decision) |
| `inv-interface-builder.md` | 61 | 61 | 0 |
| `inv-governance-admin.md` | 63 | 54 | 9 (multi-org membership/switcher, account/company admin tiers, default login org, multi-org SSO, plan-tier lifecycle, formal compliance certs, PrivateLink, vendor impersonation, self-hosted execution agent) |
| `inv-ai.md` | 40 | 40 | 0 |
| `inv-solutions-guides.md` | 58 | 56 | 2 (guide catalog hub; "adapt to your stack" doc convention) |
| **Total** | **337** | **320** | **17** |

All 17 "out of scope" items are individually listed with reasoning in
`port-capability-inventory.md` Appendix B, and every one is either a Port-SaaS
commercial/hosting/marketing-only concern, or an explicit project.md §1/§6
scope exclusion (multi-cloud/Kubernetes control plane, few-known-tenants
model) — none is a silent drop. Three items (Port execution agent, outbound-IP
allowlisting, Kafka action/backend) are carried instead into the Decisions
section below because they hinge on a human call, not a reasoning-only
exclusion.

Method: each file's own numbered/bulleted "Gaps summary" list was walked
item-by-item and assigned to exactly one change id (see the per-file mapping
worked out during drafting); closely related items were then grouped into the
single consolidated rows shown in `port-capability-inventory.md` so the table
stays usable. Cross-file duplicates (e.g. the Slack app, appearing in
`inv-interface-builder.md`, `inv-governance-admin.md`, and `inv-ai.md`; scorecards
appearing in `inv-workflows.md`, `inv-governance-admin.md`, and
`inv-solutions-guides.md`) are counted once per source file (since each file
flags the gap independently) but assigned to a single change (`034`, `012`/`013`).

---

## Decisions for the human

> **Resolved 2026-09-28 (see `openspec/project.md` §23).** The human approved the
> roadmap with Claude's recommended options, which favour full Port parity and
> override several recommendations below: D1 outbox + SSE in `023`; D2 Terraform
> provider with a bridged Pulumi provider (`040-iac-provider`); D3 execution agent
> (`041-execution-agent`); D4 build `034`; D5 build the nodes in `028`; D6 keep
> `037`/`038` in Phase 1; D7 `042-multi-org`; D8 switch to JQ (ADR-0012).

Per project.md §20, each item below needs an explicit answer before the
corresponding change's `design.md` can be written with confidence.

### D1. Kafka vs. BullMQ for externally-consumable per-tenant event topics
Port's Kafka action/backend gives each customer org a durable, externally
consumable topic; project.md §4 already substitutes BullMQ/Postgres NOTIFY, but
that is an *internal* queue, not something an external consumer can subscribe to.
- **Option A (recommended)**: Don't build a topic abstraction. Cover the same use
  case with the generic webhook action node (023/006) — fan out to as many
  external HTTP consumers as needed. Matches "no new infra just to match a Port
  feature name."
- **Option B**: Add a lightweight per-tenant outbox table + long-poll/SSE
  endpoint external consumers can read from, reusing 001's `catalog_change_event`
  pattern for workflows.
- **Option C**: Introduce a real Kafka/Redpanda cluster as a new piece of
  infrastructure, purely for this feature.
- **Recommendation**: A. Revisit B only if a concrete external-consumer use case
  appears; C contradicts the stack's stated preference for fewer moving parts.

### D2. IaC provider for Tayzu's own resources (blueprints/entities/workflows/pages/permissions)
Port ships full Terraform *and* Pulumi providers for its own data model; project.md's
only stated Terraform use is Azure infrastructure (§7) and, ambiguously, workflow
authoring (§4).
- **Option A (recommended for Phase 1)**: Build export/import only (024) — JSON/
  GitOps-YAML round trip, no bidirectional Terraform state management. Cheapest,
  unblocks CI diff-gating and environment promotion without a provider to
  maintain.
- **Option B**: Build a real Terraform provider (Go, using the Terraform Plugin
  Framework) for blueprints/workflows only, skip Pulumi.
- **Option C**: Full parity — Terraform + Pulumi providers for every resource
  type Port covers.
- **Recommendation**: A now, with B revisited once a customer team asks for
  drift-detected declarative management; C is disproportionate to a private
  deployment's likely usage.

### D3. Self-hosted execution agent / air-gapped action relay
Port's execution agent lets a workflow reach a backend with no inbound ingress
(Kafka-topic or HTTP-polling relay). project.md's Azure Container Apps design
assumes reachable webhook targets.
- **Option A (recommended)**: Out of scope for Phase 1. No known Tayzu use case
  needs an air-gapped/VPC-isolated backend yet.
- **Option B**: Build a minimal HTTP-polling relay now, reusing the BullMQ worker
  pattern, as a defensive feature.
- **Recommendation**: A; revisit in Phase 2/3 if a customer environment
  materializes that needs it.

### D4. Slack as a human-interaction/notification channel
Slack is not in project.md §8's integration priority list, but Port uses it as a
first-class notification *and* AI-interaction surface (dynamic routing,
interactive Input-node forms, compliance messaging).
- **Option A**: Build `034-notifications-and-slack` in Phase 1 as scoped above.
- **Option B (recommended)**: Defer `034` to Phase 1.5/2. Ship the Input node and
  scorecard notifications over generic webhook + email first; add Slack only once
  a real team asks for it, since it is the single largest net-new integration
  surface (OAuth app review, interactive-forms API) not currently justified by
  any named Tayzu customer.
- **Recommendation**: B, revisit once the platform has real internal users who
  ask for it.

### D5. Outbound orchestration nodes for third-party managed-agent platforms (Claude Managed Agents, Cursor Cloud Agents)
These are workflow nodes that start/continue a session with a vendor-hosted
agent product — architecturally different from `028-ai-agents` (agents *of*
Tayzu's own catalog).
- **Option A**: Build both nodes in `028` as scoped.
- **Option B (recommended)**: Skip for Phase 1. Tayzu's own agents (028) already
  cover the "agent acts on the catalog" need; adding outbound control of two
  fast-moving external vendor APIs is speculative scope, not a Phase-1
  "identical Port" requirement in spirit (it is closer to a Port distribution
  partnership than a core IDP capability).
- **Recommendation**: B; revisit if Tayzu's own users adopt Claude Managed
  Agents or Cursor Cloud Agents directly.

### D6. Self-Healing Incidents & Autonomous Ticket Resolution — build now vs. defer
`037` and `038` are large packaged solutions that compose almost every other
change and, per the source inventory's own notes, represent Port's newest and
most complex frameworks.
- **Option A**: Keep them in Phase 1 as `037`/`038`, last in the roadmap.
- **Option B (recommended)**: Ship Phase 1 through `036` (i.e. everything except
  `037`/`038`) as "identical Port," and treat `037`/`038` as an explicit Phase 1.5
  follow-on once `011` (aggregation properties), `012` (scorecards), and `028`
  (agents) have real production mileage — building a blast-radius engine or a
  confidence-decay incident model on unproven primitives risks getting the
  design wrong twice.
- **Recommendation**: B, but keep both changes fully specified in this roadmap
  (as done above) so the option to build them is not lost.

### D7. Multi-org / multi-tenant switching UX
project.md §6 targets "few known private tenants" with logical (not physical)
isolation and no per-user org switcher.
- **Option A (recommended)**: Keep this as designed — single-tenant-per-deployment
  UX, no org switcher, no account/company-admin tiering. Add per-tenant SSO/SCIM
  (025) but not multi-org SSO architecture.
- **Option B**: Build a lightweight org switcher now, anticipating that "few
  known tenants" might grow.
- **Recommendation**: A; this is a cheap decision to revisit later since project.md
  §6 already notes tenant isolation "no impide separar selectivamente un tenant
  específico más adelante."

### D8. JQ vs. JSONata (confirmation, not an open question)
Flagged for completeness: project.md's ADR-0002 already resolved this in favor of
JSONata for all mapping/condition/calculation contexts, including the new
`011-catalog-advanced-properties` calculation/aggregation properties and `023`'s
mapping engine. No action needed beyond porting Port's JQ-pitfalls cookbook
(`common-jq-use-cases.md`) into a JSONata-equivalent reference doc as part of
`004`/`011`'s Docs-as-Code deliverables — noted here only so it isn't mistaken for
an open decision during `spec-writer` review.

---

## Critic review

An adversarial pass cross-checked all seven source inventories, this proposal,
`port-capability-inventory.md`, `openspec/project.md`, and a fresh fetch of
`docs.port.io/llms.txt` (full index scan, with extra attention to
getting-started, glossary, troubleshooting, platform-administration, port-ai,
agent-management, interface-builder, governance, workflows, and solutions).

**Capability coverage** — no missing capabilities found. Every capability-inventory
row already carries a valid `Tayzu change`/`decision`/`out of scope` assignment
(verified programmatically — zero blank or malformed cells). A full-index diff
against the fresh `llms.txt` (707 documented paths) turned up 33 paths with no
textual match in the two files; all 33 were manually confirmed to be either
sub-detail pages of already-assigned capabilities (e.g. individual AWS
resource-reference pages under the already-out-of-scope AWS integration, or
`octopus-deploy`/`github-copilot`/`azure-monitor` failing only a hyphen-vs-space
string match against long-tail rows that already name them) — zero genuine gaps.
Two more targeted spot-checks (`inv-context-lake-model.md` and
`inv-governance-admin.md`'s full "Gaps summary" sections, 38 + 63 items) confirmed
every item maps to an existing row. The Appendix B "out of scope" list was checked
item-by-item against `project.md` and found fully justified in every case (each
ties to an explicit §1/§6/§7 exclusion or a genuine Port-SaaS-vendor-only concern
with no product analogue for a private deployment) — no unjustified exclusions.

**Dependency-order mistakes found and fixed** (three forward references, i.e.
a change depending on a change with a *higher* number that is built later —
all three real content dependencies, not typos):
1. `013-scorecards-integrations-and-groups` depended on `021-integrations-devops-batch`
   for its "Jira/GitHub issue automation" sub-feature. Fixed by moving that
   sub-feature's assignment to `021` itself (which now depends on `013` instead —
   `021` is built later and consumes `013`'s already-existing `_rule_result`
   event-trigger enrichment). `013`'s own scope/capabilities-covered list and the
   consolidated inventory's "Third-party compliance integrations" row were
   updated to match.
2. `022-integrations-security-batch` depended on `023` "for its generic webhook
   connector, reused for Orca/CodeRabbit" — but Orca/CodeRabbit are hard-coded
   adapters that only need `004`'s own poll/webhook `IntegrationAdapter`
   contract, per the inventory's own description of that row. Dropped the
   dependency; `022` now depends only on `004`.
3. `029-ai-assistant` depended on `030-ai-registry-llm-providers` for
   per-request provider/model override. Since both are adjacent, independent
   entries in the same tier (Tier 6) and nothing else in the roadmap depends on
   the assistant change, swapped their numbers instead of hacking the
   dependency: the registry is now `029` and the assistant `030` (physically
   reordered in the document to match), with every cross-reference in both files
   (roadmap prose, dependency lists, and 13 capability-inventory rows) updated.

Also fixed, found while verifying the above: the phrase "old `0NN`" (referring to
project.md §11's original numbering) collided with six *new* change IDs in this
same document — old `008/010/011/012/013/014` each now name a completely
different change than new `008/010/011/012/013/014`. Every occurrence was
rewritten to name the change explicitly (e.g. "project.md's old
`013-mcp-server`") so a reader can no longer misread it as this proposal's own
`013-scorecards-integrations-and-groups`.

**Oversized change found and split**: `023-integrations-generic-webhook-and-longtail`
bundled two unrelated things under one id — the reusable connector/webhook
*framework* (generic webhook connector, no-code REST connector, mapping
playground, GitOps, S3 ingestion, multi-source ingestion, outbound sync) and the
entire ~40-category native-integration *backlog* (Appendix A) that consumes it —
making it by far the largest, least cohesive change in the roadmap and the only
one that didn't fit the doc's own "~30-80 TDD tasks" sizing target. Split into:
- `023-integrations-generic-webhook-and-connector-framework` — framework only,
  dependency unchanged (`004`).
- `039-integrations-long-tail-backlog` (new, appended at the end since nothing
  in the roadmap depends on it, so it introduces no dependency-order problem) —
  the adapter backlog, `port.yml`-mechanism aside, plus the GitLab/Jenkins/
  Terraform-Cloud workflow backends and the n8n consumption pattern that were
  previously mixed into `023`. Depends on `004, 023`.
All capability-inventory rows and Appendix A's "023 (long-tail)" markers were
repointed to `039`; roadmap changes 39 total now (`001`-`039`), 22 wholly new
(mapping table updated). No other change was found to be egregiously oversized
or undersized enough to warrant a further split/merge.

**Scope-vs-claim spot checks**: sampled ~15 changes' "Scope" prose against their
"Port capabilities covered" and "Dependencies" lines for mismatches beyond the
three above; none found (e.g. `020`'s explicit mention of the approvals control
panel is mirrored in its capabilities list; `037`/`038`'s dependency lists match
every primitive their prose says they compose).
