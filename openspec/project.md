# MASTER PROMPT — Tayzu (Agentic SDLC Platform, evolución de IDP a ADP)

> Este documento consolida y **supersede** a `IDP-Agentico-Kickoff-Prompt.md` y `IDP-Agentico-Arquitectura-Tecnica.md`. Es el único documento que hace falta copiar en `openspec/project.md` y usar como primer mensaje de Claude Code. Todo lo que sigue son decisiones ya cerradas — no ADRs a debatir, sino contexto persistente del proyecto.

**Nombre del producto: Tayzu.**

---

## 1. Visión y alcance

Tayzu es una plataforma de Internal Developer Platform (IDP) de uso privado, inspirada en la arquitectura pública de Port.io (`docs.port.io`, `port.io/guide`, `roadmap.getport.io`, blog y job postings de Port), construida 100% desde cero con stack propio. No es un fork ni reutiliza código propietario de Port.

**Posicionamiento**: Tayzu se define como una **Agentic SDLC Platform** — la evolución de un IDP tradicional hacia un **ADP (Agentic Developer Platform)**, término activo en la industria (PlatformCon 2026 lo trató como tema central, con la relación informal `ADP = IDP × agentic paths × agents`). El framework de componentes de un ADP mapea directamente a piezas ya diseñadas en este documento, y ese es el vocabulario a usar de acá en adelante para referirse a cada capa:

| Componente ADP | Pieza de Tayzu | Sección |
|---|---|---|
| Context assembly | Blueprint / Entity / Relation (catálogo) | 3 |
| Tool gateway | MCP server | 11, `013-mcp-server` |
| Execution substrate | Motor de Workflows | 4 |
| Trust plane | Cerbos (Policy-Driven Development) | 9.1 |
| Evaluation | Eval-Driven Development para agentes | 16.9 |
| Observability | Observability-Driven Development | 9.3 |

Adoptar también los **cuatro modos de control** de ese mismo framework para describir la autonomía de un trigger `agent` en un Workflow (Sección 4): **assistive** (el agente sugiere, un humano ejecuta), **task** (el agente ejecuta un paso puntual con supervisión), **workflow** (el agente corre un workflow completo dentro de límites ya aprobados), **bounded autonomy** (el agente decide y ejecuta sin intervención humana por request, dentro de políticas de Cerbos explícitas). Todo trigger `agent` de un Workflow declara en cuál de estos cuatro modos opera — nunca es un simple "sí/no" a la autonomía.

**Alcance de esta fase (Fase 1)**: réplica funcional de Port — catálogo, workflows (self-service + automations unificados), scorecards, integraciones, capa de IA. Las self-service actions siguen delegando la ejecución real a sistemas externos (Terraform, GitHub Actions, Azure DevOps Pipelines), igual que Port. **No** se construye un control plane propio de multi-cloud/multi-cluster tipo nullplatform/Fury en esta fase — queda documentado como Fase 2/3 futura, fuera de scope por ahora.

**Principio arquitectónico no negociable** (tomado directamente de cómo evolucionó Port): *humanos y agentes de IA ejecutan exactamente el mismo camino de workflow — mismos nodos, mismos permisos, mismo audit trail. Nunca existe un "atajo" de automatización que esquive la gobernanza.* Toda decisión de diseño posterior se evalúa contra este principio.

---

## 2. Stack tecnológico final (con ADRs)

| Capa | Elección | ADR |
|---|---|---|
| Frontend framework | React + Vite + TypeScript | — |
| UI components | **shadcn/ui sobre Radix UI + Tailwind CSS** | ADR-0007 |
| Canvas de workflows/relations | React Flow | — |
| Data fetching / estado | TanStack Query (servidor) + Zustand (UI local) | ADR-0004 (recomendación, sin confirmación directa en Port) |
| Formularios dinámicos | react-hook-form + Zod, generador propio desde JSON Schema | — |
| Docs de producto | Docusaurus | — |
| Backend framework | Fastify + oRPC (OpenAPI 3.1 nativo) | — |
| Motor de integraciones ("Ocean" propio) | **TypeScript** (no Python) | ADR-0001 |
| Mapping de datos de integraciones | **JSONata** (no JQ nativo) | ADR-0002 |
| CLI para devs / agentes futuros en host/pod | **Go** (cuando se construya) | ADR-0003 |
| Motor de policies (RBAC/ABAC) | **Cerbos** (no OPA — fundadores de OPA se fueron a Apple en 2025, Styra descontinúa su oferta comercial) | — |
| ORM / migraciones | Drizzle ORM | — |
| Base de datos | PostgreSQL (Azure Database for PostgreSQL Flexible Server) | — |
| Multi-tenancy | Schema único + columna `tenant_id` + Row-Level Security de Postgres | ADR-0006 |
| Cola de jobs / scheduler | BullMQ + Redis (Azure Cache for Redis) | — |
| Auth | Better Auth (plugins: `organization`, `admin`, `api-key`, `two-factor`) | — |
| Observabilidad | OpenTelemetry SDK → Azure Monitor / Application Insights | — |
| Testing | Vitest + Testing Library + Playwright | — |
| Monorepo | Turborepo + pnpm workspaces | — |
| Hosting | **Azure Container Apps** (no AKS por ahora) | ADR-0005 |
| CI/CD | GitHub Actions → Azure Container Registry → `az containerapp update` | — |
| Decisiones rápidas de alto volumen (scoring, triage, routing) | Interfaz propia `DecisionProvider` — implementación por defecto: Claude con structured output; Jev (TypeSafe AI) queda anotado como candidato a reevaluar en 3-6 meses (a fecha de este documento tiene ~2 semanas de vida, sin track record ni forma de auditar sus benchmarks de forma independiente — mismo tipo de riesgo de proveedor único que ya vimos con OPA/Styra). Si en ese momento sigue en pie, migrarlo es cambiar una implementación detrás de una interfaz que ya existe, no un rediseño | — |

**ADR-0007** (nuevo): *Se elige shadcn/ui sobre Radix UI + Tailwind en vez de un design system 100% custom desde cero, a pesar de que Port (con un equipo de Frontend Infra dedicado) probablemente construye el suyo enteramente a medida. La razón es específica al modo de desarrollo de este proyecto: la CLI de shadcn trae un servidor MCP (`npx shadcn@latest mcp init --client claude`) que le da a Claude Code acceso directo a componentes ya curados durante el desarrollo — una ventaja que Port no necesita (tiene humanos dedicados a esto) pero que es determinante acá. Se puede migrar a componentes más a medida más adelante sin romper nada, porque shadcn no es una dependencia en runtime — el código de cada componente se copia al repo, se posee 100%.*

---

## 3. Modelo de datos base

- **Blueprint** (esquema, como una clase) → **Entity** (instancia) → **Relation** (vínculo tipado) → **Property** (campo).
- Todo Entity separa **`spec`** (deseado, lo que el usuario configuró) de **`status`** (observado, lo que trae el sync) — modelo tomado de Kubernetes, gratis de implementar ahora, carísimo de retrofitear después si algún día se llega a la Fase 2 de control plane propio.
- Toda tabla lleva **`tenant_id`** desde la primera migración (`organization.id` de Better Auth).
- El layout de página de un Entity se define **una vez por Blueprint**, no por Entity — todas las entities del mismo blueprint heredan el mismo layout (patrón confirmado de Port).
- Los **Workflows son ellos mismos entities** de un blueprint interno reservado (equivalente al `_workflow` de Port) — ownership, permisos y auditoría de workflows usan el mismo modelo de Blueprint/Entity/Relation que el resto del catálogo, no un sistema aparte.

---

## 4. El motor de Workflows (unificado — reemplaza self-service actions + automations como sistemas separados)

Corrección importante sobre el roadmap original: Port unificó self-service actions y automations en un solo motor de grafo llamado Workflows (Open Beta, 2026), documentando el sistema anterior como "legacy". Se construye directamente el motor unificado, sin pasar por la versión separada.

**Modelo**: grafo dirigido de nodos + edges.

- **Trigger** (entrada, puede haber varios en un mismo workflow, cada uno con sus propios permisos):
  - `manual` (self-service, formulario generado desde JSON Schema)
  - `event` (basado en cambios de entities del catálogo)
  - `schedule` (cron)
  - `agent` (invocado como tool de tu futuro MCP server — `trigger_run` equivalente)
- **Action** (operación): enviar webhook, upsert de entity, publicar evento (Postgres NOTIFY / BullMQ en vez del Kafka de Port), disparar una integración externa (GitHub Actions/Azure DevOps Pipelines/Terraform), invocar un `DecisionProvider` o un agente de IA.
- **Condition** (branching): expresiones evaluadas en runtime (usar JSONata en vez de JQ, consistente con ADR-0002), primera coincidencia gana, con rama de fallback.

**Formas de autoría** (las 4 que soporta Port, replicar todas): editor visual (React Flow), modo JSON directo, conversación con un agente de IA (patrón "proponer como diff → revisar → aplicar" — literalmente el mismo ciclo que ya usamos con OpenSpec, así que la implementación de este flujo puede reusar la misma UI de revisión de diffs), e Infrastructure-as-Code (Terraform o el formato que se defina).

**Runs**: cada ejecución de un workflow es un `WorkflowRun`, con estado, timeline de nodos ejecutados, y — desde el diseño, no como parche — soporte para reintentar (re-run) desde el nodo que falló, no solo desde el principio.

---

## 5. UI / UX

- **Global search**: `Cmd+K`/`Win+K`, resultados categorizados (Entities, Docs, Workflows, Blueprints), configurable por admin qué blueprints indexar.
- **Entity page**: layout definido a nivel de Blueprint (ver Sección 3). Tab "Overview" = dashboard de widgets (widget "Details" por defecto + agregables). Tabla de relaciones auto-poblada (forward/backward), columnas configurables, relaciones indirectas agregables a mano.
- **Modo "Builder"** separado del uso diario: configuración de blueprints, políticas de Cerbos, gestión de plugins, settings de organización — nunca mezclado con la navegación normal del catálogo.
- **Extensibilidad vía plugins sandboxeados**: cada plugin es una mini-SPA en React+TS compilada a un único `dist/index.html` (usar `vite-plugin-singlefile`), subida y hosteada por tu propio backend, renderizada en un iframe, comunicación exclusivamente vía `postMessage` (patrón: usuario, params, entity data, tema claro/oscuro, JWT de corta duración para llamar a tu API). Aislamiento real, sin infraestructura por plugin.
- **Canvas de Workflows y de grafo de relaciones**: React Flow. Tomar como referencia de UX ya validada en producción el "Catalog Graph" de Backstage: filtro de profundidad máxima, toggle de fusionar relaciones, filtro por tipo/relación, modo simplificado, zoom con pinch, click para cambiar nodo activo, shift+click para navegar a la entidad.
- **Tema**: soporte claro/oscuro desde el día uno (Port lo pasa como contexto incluso a los plugins de terceros).

---

## 6. Multi-tenancy

Shared schema + `tenant_id` + Row-Level Security de Postgres (ver ADR-0006). `organization.id` de Better Auth **es** el `tenant_id`. Cerbos incluye `tenant_id` como primer atributo de filtro en toda policy. No se aísla infraestructura física por tenant en esta fase — es aislamiento lógico, suficiente para pocos tenants privados conocidos, y no impide separar selectivamente un tenant específico más adelante si hiciera falta.

---

## 7. Despliegue en Azure Container Apps

- Un único ACA Environment con VNET integration.
- App web+API (Fastify): ingress externo, `minReplicas: 1`.
- Workers de BullMQ: ingress interno únicamente, autoscaling KEDA sobre longitud de cola, `minReplicas: 0`.
- Resyncs periódicos de integraciones: **ACA Jobs** (trigger `Schedule`/`Event`), no workers siempre vivos.
- Azure Database for PostgreSQL Flexible Server, Azure Cache for Redis, Azure Container Registry, Azure Key Vault (secretos vía referencia nativa de ACA).
- Observabilidad: OpenTelemetry → Azure Monitor / Application Insights.
- CI/CD: GitHub Actions → build → push a ACR → deploy a ACA. Todo en Bicep o Terraform, versionado (Pipeline-as-Code).

---

## 8. Integraciones nativas prioritarias

Todas siguen la misma interfaz `IntegrationAdapter` (poll y/o webhook → JSONata mapper → upsert de entity):

| Herramienta | Patrón | Referencia |
|---|---|---|
| GitHub | Poll (exporter) + webhook (real-time) | Integración más completa del catálogo de Port — usar como plantilla principal |
| Jira Cloud | Poll + webhook | Integración nativa de Port |
| Azure DevOps | Poll + webhook | Integración nativa de Port (sync de pipelines + self-service) |
| Aikido | Poll + webhook | Integración nativa de Port (patrón compartido con Snyk/Wiz/SonarQube) |
| Orca Security | **Webhook saliente desde Orca** (su feature de "Automations" empuja alertas), no polling | Blueprint documentado por Port: `orcaSecurityAlert` (severity, riskLevel enum, status, recommendation, category, alertLabels) |
| Escape | Poll a API REST (`public.escape.tech/v3`, OpenAPI publicado, header `X-ESCAPE-API-KEY`) | Sin integración nativa en Port — construir adapter propio |
| CodeRabbit | Webhook de la plataforma Git (evento de PR review comment con autor = bot de CodeRabbit) | Sin integración nativa en Port — CodeRabbit corre como agente propio con API key |

---

## 9. Las 5 metodologías (resumen operativo)

1. **Policy-Driven Development**: todo pasa por Cerbos, políticas versionadas en `/policies`, testeadas antes de que el código que las consume se implemente.
2. **Agentic TDD**: rojo-verde-refactor estricto por cada item de `tasks.md`. Contract-check de OpenAPI obligatorio en CI.
3. **Observability-Driven Development**: cada `design.md` declara su contrato de telemetría (nombres de spans/métricas OTel) antes de implementar. Cada `WorkflowRun` y cada sync de integración es un trace de punta a punta.
4. **Docs-as-Code**: ningún `openspec change` se archiva sin actualizar su doc afectada. ADRs en `docs/adr/` el mismo día que se decide algo.
5. **Pipeline-as-Code**: CI, migraciones, policies de Cerbos y la infraestructura de Azure, todo versionado, nada configurado a mano.

---

## 10. Flujo Human-in-the-Loop: OpenSpec + Claude Code (entorno de nube)

```
1. openspec/project.md = este documento. Contexto persistente, no se reescribe por sesión.
2. Por cada capability del roadmap (Sección 11):
   a. Generar proposal.md + specs/*.md (RFC2119 + Given/When/Then) + design.md
      (incluye contrato de observabilidad) + tasks.md
   b. ⛔ CHECKPOINT 1: aprobar la propuesta antes de escribir código.
   c. Claude Code, en su entorno de sandbox/nube (revisar la documentación vigente
      en platform.claude.com/docs para el setup exacto del entorno administrado,
      ya que evoluciona), ejecuta Agentic TDD tarea por tarea.
   d. Pipeline completo en el sandbox: lint, tests, contract-check, otel-smoke-check.
   e. Abre PR.
   f. ⛔ CHECKPOINT 2: revisar el PR completo.
   g. ⛔ CHECKPOINT 3 (siempre, sin excepción): cualquier cambio de policy de Cerbos
      o migración de schema se aprueba explícitamente aparte, aunque el resto del
      PR ya esté aprobado.
   h. Merge → `openspec archive`.
3. Repetir.
```

---

## 11. Roadmap de OpenSpec changes (actualizado)

1. `001-catalog-core` — Blueprint/Entity/Relation/Property, separación spec/status, `tenant_id` desde el día uno
2. `002-auth-and-rbac` — Better Auth + Cerbos + multi-tenant RLS
3. `003-catalog-ui` — vista de catálogo, shadcn/ui, entity page con layout por blueprint
4. `004-workflow-engine-core` — motor de grafo unificado (trigger/action/condition), sin canvas visual todavía
5. `005-workflow-canvas` — editor visual con React Flow + modo JSON
6. `006-workflow-ai-authoring` — construcción de workflows por conversación con IA (patrón proponer-diff-revisar-aplicar)
7. `007-scorecards` — reglas, niveles, dashboard básico
8. `008-integrations-sdk` — "Ocean" en TS: adapters de GitHub, Jira, Azure DevOps, Aikido
9. `009-integrations-security-tools` — Orca Security (webhook), Escape (poll), CodeRabbit (webhook)
10. `010-observability-dogfood` — blueprints Service/Deployment + OTel end-to-end sobre el propio proyecto
11. `011-docs-as-catalog-entities` — documentación versionada por entidad
12. `012-plugins-sandbox` — sistema de plugins vía postMessage + `vite-plugin-singlefile`
13. `013-mcp-server` — envolver procedures de oRPC + workflows como tools MCP
14. `014-ai-agents` — agentes propios sobre el catálogo, gobernados por Cerbos, mismo camino de ejecución que un humano (Sección 1)

*(Fases 2/3 — control plane propio con Crossplane/Cluster API/ArgoCD, capa "scopes" tipo nullplatform — quedan fuera de este roadmap, documentadas como futuro no comprometido.)*

---

## 12. Primer mensaje real para Claude Code

```
Antes de arrancar: las reglas fijas del proyecto están completas en
openspec/project.md, que ya está en el repo. Leelo entero antes de hacer nada.

Ya tenés instalados sdd-superpowers, Superpowers, claude-code-review-council y
coderabbit. Usalos como apoyo de criterio (brainstorming, disciplina de TDD,
checklist de review) — pero la estructura de archivos y el formato de cada
propuesta siguen siendo los de OpenSpec (proposal.md/specs/design.md/tasks.md
dentro de openspec/changes/). No reemplaces esa estructura por la de otro plugin.

Empezamos por la primera capability del roadmap: 001-catalog-core.

Generá, dentro de openspec/changes/archive/2026-09-28-001-catalog-core/:
- proposal.md
- specs/catalog-core.md (MUST/SHOULD/MAY + escenarios Given/When/Then)
- design.md (incluye el contrato de observabilidad: qué spans y métricas de
  OpenTelemetry va a emitir esta capability)
- tasks.md (checklist, cada item pensado para un ciclo de TDD
  rojo-verde-refactor autocontenido)

No implementes nada todavía. Quiero revisar y aprobar la propuesta antes de que
se escriba una sola línea de código.
```

**Setup previo a este mensaje**: repo creado → `openspec init` → reemplazar el `openspec/project.md` generado por el contenido completo de este documento → instalar en Claude Code los plugins `sdd-superpowers`, `Superpowers`, `claude-code-review-council` y `coderabbit` → recién ahí enviar el mensaje de arriba. El archivo de este documento no se "adjunta" en cada sesión — vive en el repo como `openspec/project.md`.

---

## 14. Regla de idioma para el desarrollo

**Todo el desarrollo y todos los archivos del proyecto van en inglés, sin excepción**: código, nombres de variables/funciones/tablas, comentarios, commits, nombres de blueprints/entities del sistema, `proposal.md`/`specs/*.md`/`design.md`/`tasks.md` de OpenSpec, ADRs en `docs/adr/`, mensajes de error internos, logs, nombres de spans de OpenTelemetry, documentación técnica (Docusaurus incluido). **La única excepción es la conversación entre Claude y el humano (vos)**, que se mantiene en español. Esta regla es independiente de la Sección 15 (idiomas que el *producto terminado* ofrece a sus usuarios finales) — no hay que confundir "en qué idioma está escrito el código" con "en qué idiomas puede usarse la aplicación una vez construida". Agregar esta regla explícitamente al primer mensaje de cada sesión nueva de Claude Code, ya que es el tipo de convención que se diluye con el tiempo si solo vive en un párrafo de contexto largo.

---

## 15. Internacionalización (i18n) y zonas horarias del producto

**Sobre cómo lo maneja Port**: no encontré confirmación pública de que Port ofrezca una UI multi-idioma, ni una página de configuración de timezone documentada — lo cual, en sí mismo, es información útil: es el patrón estándar de herramientas de ingeniería B2B globales (el inglés es la lengua franca de la profesión, así que muchas ni invierten en localización de UI). Es una inferencia razonada, no un hecho confirmado con cita — tratala como tal.

**Lo que sí es una buena práctica universal, la use Port o no**: guardar **todo timestamp en UTC en la base de datos**, sin excepción, y resolver la zona horaria de despliegue únicamente en la capa de presentación (frontend), nunca en el backend ni en la base de datos.

**Para tu caso (Español + Inglés desde el día uno)**:
- Librería de frontend: **`react-i18next`** (la opción más madura del ecosistema React, con soporte de namespaces para code-splitting de traducciones por feature — relevante porque el catálogo va a crecer mucho).
- Los `Blueprint` y sus `Property.title`/`Property.description` necesitan soportar valores localizados desde el modelo de datos (no hardcodeado en el frontend) — es decir, el JSON Schema de un blueprint ya contempla `title` como un objeto `{ "en": "...", "es": "..." }` o vía claves de traducción, no como string plano. Igual que con `tenant_id`, este es un seam barato de meter ahora y caro de agregar después si ya hay blueprints reales cargados.
- Zona horaria: guardar `UTC` en Postgres (`timestamptz`), resolver a la timezone del navegador del usuario en el cliente vía la API `Intl` / `Temporal` (el reemplazo moderno de `date-fns-tz` que ya tiene soporte nativo en navegadores 2026) — sin campo de configuración manual de timezone en v1, se puede agregar como preferencia de usuario más adelante si hace falta.
- Better Auth: el locale del usuario se guarda como metadata de perfil, no como parte del modelo de autenticación en sí.

---

## 16. Frameworks de trabajo adicionales (éxito del proyecto y optimización de tokens)

Suman a las 5 metodologías de la Sección 9, específicos para el modo de trabajo con Claude Code:

6. **Context Engineering jerárquico (`CLAUDE.md` anidados)**: un `CLAUDE.md` raíz con las convenciones globales (breve, estable, cacheable) + un `CLAUDE.md` por paquete del monorepo (`apps/web/CLAUDE.md`, `apps/server/CLAUDE.md`, `packages/integrations-sdk/CLAUDE.md`) con las convenciones específicas de esa carpeta. Claude Code carga solo el contexto relevante al área donde está trabajando en vez de todo el proyecto en cada turno — esto es directamente optimización de tokens, no solo prolijidad.
7. **Disciplina de prompt caching**: `openspec/project.md` (este documento) se trata como contexto **estable** — no se reescribe entero en cada sesión, solo se le agregan secciones o ADRs puntuales al final. Un documento de contexto que cambia poco entre turnos es cacheable por la API de Anthropic, lo que baja el costo real de repetirlo en cada llamada a lo largo de una sesión larga.
8. **Golden Path Scaffolding**: generadores/templates para los artefactos que se van a repetir muchas veces — un nuevo Blueprint, un nuevo adapter de integración, un nuevo tipo de nodo de Workflow. En vez de que el agente "piense" la estructura de cero cada vez, completa una plantilla ya probada (mismo patrón que las integraciones "scaffolder"/Cookiecutter que ya vimos en el catálogo de Port). Menos tokens gastados en boilerplate, más consistencia entre módulos escritos por sesiones distintas.
9. **Eval-Driven Development para la capa de IA del producto** (distinto de Agentic TDD, que es sobre cómo se escribe el código): cuando se llegue a `013-mcp-server` y `014-ai-agents`, cada agente/workflow con nodo de IA necesita un set de casos de prueba dorados (input → output esperado, con tolerancia donde aplique) evaluados offline antes de cada cambio de prompt o de modelo — un TDD para el comportamiento del agente, no para el código que lo invoca.
10. **Compactación de contexto en checkpoints, no a mitad de tarea**: usar `/compact` de Claude Code únicamente después de que un `openspec change` se archiva (checkpoint natural), nunca en medio de un ciclo rojo-verde-refactor sin terminar — evita perder contexto relevante de una tarea a medio hacer.

---

## 17. MCPs necesarios para el desarrollo

Importante: esto es el **toolbelt de Claude Code mientras construye la plataforma** — no confundir con el MCP server que el producto mismo va a exponer a sus usuarios finales (roadmap `013-mcp-server`, Sección 11). Son dos cosas distintas que coexisten.

| MCP | Uso durante el desarrollo | Tipo |
|---|---|---|
| **GitHub MCP** (oficial) | Repos, issues, PRs, Actions, security — el mecanismo real detrás de los Checkpoints 1/2 del flujo Human-in-the-Loop (Sección 10) | Imprescindible |
| **Azure MCP** (oficial, `microsoft/mcp`) | Todas las herramientas de Azure en un solo server — Container Apps, Key Vault, Azure Database for PostgreSQL, todo con autenticación por Managed Identity | Imprescindible (es la nube elegida) |
| **Azure DevOps MCP** (oficial Microsoft) | Útil doblemente: para gestionar el propio proyecto si se usa ADO como tracker, y para probar en carne propia la integración `Azure DevOps` de la Sección 8 mientras se construye | Alta prioridad |
| **Postgres MCP Pro** (open source) | Inspección de schema, `EXPLAIN` plans, chequeos de salud, ejecución segura de SQL de solo lectura — útil para verificar migraciones de Drizzle y el comportamiento de las policies RLS de la Sección 6 | Alta prioridad |
| **Playwright MCP** (oficial Microsoft) | Maneja un browser real — verificación visual de la UI y soporte directo para los tests E2E ya elegidos en el stack | Alta prioridad |
| **shadcn MCP** | Acceso a componentes ya curados durante el desarrollo del frontend (ver ADR-0007) | Alta prioridad |
| **Context7** | Documentación actualizada de librerías bajo demanda — crítico específicamente para oRPC, Better Auth y Cerbos, que son libraries lo bastante nuevas/nicho como para que el conocimiento de entrenamiento de cualquier modelo esté incompleto o desactualizado | Alta prioridad |
| **Atlassian Rovo MCP** (oficial) | Jira, Confluence, Bitbucket — útil para probar la integración `Jira Cloud` de la Sección 8 en un entorno real durante el desarrollo | Media prioridad |
| **Chrome DevTools MCP** | Consola, red, performance — debugging de frontend más allá de lo que cubre Playwright | Media prioridad |
| **Sentry MCP** (oficial) | Solo si se decide sumar Sentry como en Port (no está en el stack todavía) — investigación de errores en producción | Evaluar más adelante |

---

## 19. Subagentes de Claude Code para el desarrollo

Distinto de los AI Agents del producto (`014-ai-agents`, feature para el usuario final) — esto es el toolbelt de sub-agentes que usa Claude Code **para construirse a sí mismo**, definidos como `.claude/agents/*.md` (confirmar sintaxis exacta del frontmatter en `platform.claude.com/docs`, cambia seguido). El agente principal de cada sesión actúa de orquestador y los invoca en el orden del flujo de la Sección 10.

| Subagente | Hace | No hace | Refuerza |
|---|---|---|---|
| `spec-writer` | Redacta `proposal.md`/`specs/*.md`/`design.md`/`tasks.md` | Nunca implementa — se detiene en el Checkpoint 1 | El flujo OpenSpec |
| `test-writer` | Escribe solo los tests en rojo de un item de `tasks.md` | No toca código de implementación | Agentic TDD (fase roja) |
| `implementer` | Hace pasar los tests con el mínimo código necesario | No toca archivos de test | Agentic TDD (fase verde) |
| `policy-writer` | Políticas de Cerbos + sus casos de test, solo en `/policies` | No toca lógica de negocio | Policy-Driven Development |
| `observability-auditor` | Verifica, después del `implementer`, que los spans/métricas declarados en `design.md` existan de verdad | No implementa ni corrige, solo bloquea | Observability-Driven Development |
| `integration-scaffolder` | Genera un nuevo `IntegrationAdapter` desde la plantilla (Sección 8) | No inventa un patrón nuevo por integración | Golden Path Scaffolding |
| `release-notes` | Resumen para el Checkpoint 2 + actualiza la doc afectada | No aprueba el PR | Docs-as-Code |

La separación `test-writer` / `implementer` en dos contextos distintos es deliberada, no organizativa: evita que un mismo agente escriba un test y su implementación juntos y el test termine validando lo que el código hace en vez de lo que debería hacer.

---

Esta sección reemplaza a una lista plana de fuentes por una organizada por tarea — cuando Claude Code (o vos) trabaje en una capability puntual del roadmap (Sección 11), esta tabla dice a qué leer, en vez de releer todo `docs.port.io` cada vez.

### Transversal / contexto general (leer una sola vez, al principio)
| Fuente | Para qué sirve |
|---|---|
| `port.io/guide` | Filosofía y pilares de un IDP — el "por qué" detrás de cada pieza |
| `port.io/blog` | Anuncios de producto, posicionamiento actual ("Agentic SDLC Platform") |
| `docs.port.io/security` | Stack de infraestructura real de Port (AWS, Kafka, Sentry, OTel, GuardDuty) — ya extraído en Sección 2, releer solo si hace falta un detalle no capturado |
| `roadmap.getport.io` + `roadmap.port.io/changelog` | Dos usos distintos: el roadmap muestra **qué le falta a Port** (oportunidades para diferenciarte, ej. TechDocs); el changelog muestra **qué shippearon reciente** (así se descubrió Workflows) |
| Job postings de Port (`team8.vc`, `jobs.tlv.partners`, `jobs.accel.com`, buscar "Port" + rol) | Única fuente confiable para el stack de código real (no está en la documentación de producto) |
| `platformengineering.org/blog` y `platformengineering.org/reports` | Comunidad global de referencia (organizadores de PlatformCon, de donde sale el framework de ADP de la Sección 1) — fuente de comparación continua contra el resto del mercado de IDP/ADP, no específica de Port. Útil para revisar cada tanto durante el desarrollo, no solo al arrancar, ya que se actualiza con tendencias nuevas |

### Por capability del roadmap (Sección 11)

| Change | Consultar |
|---|---|
| `001-catalog-core` | `docs.port.io` → secciones de Blueprints, Entities, Relations, Properties (glosario y "Build a software catalog") |
| `002-auth-and-rbac` | `docs.port.io` → sección de RBAC/Teams/Roles |
| `003-catalog-ui` | `docs.port.io/interface-builder/*` (global search, entity page) y `docs.port.io/customize-pages-dashboards-and-plugins/*` |
| `004`–`006` (Workflows) | `docs.port.io/workflows/overview`, `docs.port.io/workflows/concepts`, `docs.port.io/workflows/build-workflows/iac`, `docs.port.io/guides/all/build-port-workflows-with-mcp`, `port.io/blog/port-workflows` — **esta es la documentación más nueva y más importante de todas, léela completa antes de tocar el motor de workflows** |
| `007-scorecards` | `docs.port.io` → sección de Scorecards |
| `008`–`009` (Integraciones) | `docs.port.io/build-your-software-catalog/sync-data-to-catalog/` (índice completo de integraciones) + `ocean.port.io` (arquitectura del framework) + `github.com/port-labs/ocean` (código fuente real, es open source). Para Orca puntualmente: `docs.port.io/guides/all/ingest-vulnerability-alerts-from-orca-security-using-a-custom-webhook-integration`. Para Escape y CodeRabbit: sus propias docs (`docs.escape.tech`, `docs.coderabbit.ai`), Port no los cubre |
| `011-docs-as-catalog-entities` | No hay nada que leer de Port acá — es un feature que ellos **no tienen** (item "Exploring" del roadmap), estás diseñando desde cero con libertad total |
| `012-plugins-sandbox` | `docs.port.io/interface-builder/port-interface/plugins/`, `docs.port.io/customize-pages-dashboards-and-plugins/plugins/`, y el repo de ejemplo `port-plugin-sample` en GitHub (código real de un plugin funcionando) |
| `013-mcp-server` | `docs.port.io/port-ai/*` — el servidor MCP y sus tools (`upsert_workflow`, `list_workflows`, etc.) |
| `014-ai-agents` | `docs.port.io/port-ai/*` — Context Lake y AI Agents |

### Lo que queda honestamente sin resolver

- **`demo.port.io` está bloqueado para fetch automático** (bot detection) — nadie en este proceso pudo verlo renderizado. Si en algún momento necesitás mapear un detalle visual/de interacción exacto de la UI real (no solo lo que dice la documentación de texto), esa es una tarea que solo podés hacer vos entrando desde tu navegador — Claude Code tampoco va a poder verla por su cuenta.
- **i18n y timezone de Port** (Sección 15): sin confirmación directa, es inferencia razonada.
- **State management del frontend** (TanStack Query + Zustand): recomendación nuestra, no confirmada en ningún posting de Port.
- Las fuentes de esta lista son de **septiembre de 2026**. Port sigue en "hypergrowth" activo (Workflows pasó de closed beta a open beta a "disponible en todas las cuentas" en cuestión de meses) — antes de construir una capability puntual, vale la pena que Claude Code haga un fetch fresco de la URL correspondiente en vez de confiar ciegamente en lo resumido acá, en caso de que algo haya cambiado.

### Fuentes adicionales de infraestructura de desarrollo (no de Port)

`platform.claude.com/docs` (entorno de nube de Claude Code) · `openspec.dev` · `github.com/microsoft/mcp` (Azure MCP) · `github.com/microsoft/playwright-mcp` · `typesafe.ai/blog` (Jev)

---

## 20. Regla de preguntas abiertas (Human-in-the-Loop)

Toda pregunta abierta que solo el humano puede responder (Open Questions de un `design.md`, ítems `HUMAN` del agente VCDM, ambigüedades de alcance) **se pregunta siempre en el chat**, nunca queda solo escrita en un archivo. Cada pregunta viene con 2 a 4 opciones concretas, la recomendada marcada como tal y el porqué. Nada se da por aprobado hasta que el humano responda. Después, la respuesta se incorpora a los artefactos (el `design.md` pasa la pregunta a "Resolved decisions").

---

## 21. Modo de trabajo con GitHub (PR automático por change)

Decisión del humano (2026-09-27), aplicada por todo agente que trabaje en el repo:

- **Una rama por `openspec change`.** Nunca se commitea directo a `master`. Si la sesión de Claude Code asigna una rama, se usa esa; si no, `change/<id-del-change>` (por ejemplo `change/002-auth-and-rbac`), creada desde el `master` actualizado.
- **PR automático, sin intervención humana para abrirlo.** Al primer commit del change se abre el PR contra `master`, en **draft** mientras se implementa. El agente se suscribe a los eventos del PR (CI, reviews, comentarios) y los atiende solo: arregla el CI en rojo, responde o aplica los comentarios, y mantiene la rama al día con `master` mediante merge (nunca rebase ni force-push sobre historia compartida).
- **Checkpoint 2:** cuando el change está completo y el CI en verde, el PR pasa a **ready for review** con el resumen del change, la evidencia (CI, pre-evaluación VCDM, `/security-review`) y el checklist de `tasks.md`. El humano revisa y responde "merge" en el chat; recién ahí el agente mergea. El agente nunca mergea sin ese OK explícito.
- **Checkpoint 3:** todo PR que incluya una migración de schema o un cambio de policy de Cerbos se frena antes de la tarea que lo aplica, y el SQL o la policy se presentan en el chat para una aprobación separada. No lleva auto-merge.
- **Protección de `master`:** ruleset con PR obligatorio (0 aprobaciones, porque el agente actúa con la cuenta del humano y GitHub no permite aprobar un PR propio), checks de CI obligatorios, bloqueo de force-push y de borrado. Lo configura el humano en Settings → Rules; el agente no puede cambiar settings del repo.
- **Después del merge:** el agente corre `openspec archive` para el change y la rama no se reutiliza. El trabajo nuevo empieza en una rama nueva desde `master`.

---

## 22. Biblioteca de referencias de Platform Engineering

Reportes de platformengineering.org / Weave Intelligence (arquitecturas de referencia de un IDP en Azure, AWS y GCP; State of Platform Engineering Vol. 4; IDP soberano; observabilidad; gestión de vulnerabilidades; ciclo de vida de Kubernetes; CDEs), guardados textuales en `docs/references/platform-engineering/`. El índice (`README.md` de esa carpeta) trae el catálogo, una **matriz de relevancia por change del roadmap** con rangos de líneas y los takeaways para Tayzu.

- **Antes de proponer un change**, el paso de `spec-writer` lee la fila de ese change en la matriz y los rangos que cita, junto con las fuentes de Port de §19.
- **Cuando un `design.md` se apoya en un reporte**, cita archivo y rango de líneas, y aclara si el reporte lo dice o si es una inferencia.
- **Precedencia**: los reportes nunca reemplazan este documento, los ADRs ni un design aprobado. Si un reporte contradice una decisión, se pregunta al humano en el chat según §20.
- Las estadísticas de los reportes mayormente no tienen fuente; no se citan como hechos. Los reportes no se editan nunca (las citas por línea tienen que seguir siendo válidas).

---

## 23. Roadmap v2: copia funcional idéntica de Port (reemplaza la Sección 11)

Aprobado por el humano el 2026-09-28. Surge de un relevamiento de toda la documentación de Port (`docs.port.io/llms.txt`, 7 pilares, unas 620 capacidades) y cubre cada capacidad que faltaba o estaba parcial. El inventario completo, con la asignación de cada capacidad a un change, está en `docs/references/port/port-capability-inventory.md`, y el análisis (alcance de cada change, capacidades de Port cubiertas, docs a leer, mapeo de IDs viejos a nuevos, chequeo de cobertura) en `docs/references/port/roadmap-analysis.md`. **Antes de proponer cada change se lee su sección en ese análisis**, junto con la matriz de §22.

`001-catalog-core` conserva su alcance aprobado. Los IDs viejos 002-014 se renumeran según la tabla de mapeo del análisis.

| Change | Scope | Depends on |
|---|---|---|
| `001-catalog-core` | Catalog core (Blueprint/Entity/Relation/Property) | none |
| `002-auth-and-rbac` | Authentication, RBAC and multi-tenant isolation | 001 |
| `003-catalog-ui-core` | Catalog UI — pages, entity page, search, branding | 001, 002 |
| `004-integrations-sdk-core` | Integrations SDK ("Ocean" in TypeScript) + GitHub adapter | 001, 002 |
| `005-search-and-query` | Unified search & query engine | 001, 002, 003 |
| `006-workflow-engine-core` | Workflow graph engine (unified triggers/actions/conditions/input) | 001, 002, 005 |
| `007-workflow-runs-and-execution` | Workflow run management & execution observability | 006 |
| `008-workflow-canvas` | Visual workflow canvas (React Flow) + JSON editor | 006, 007 |
| `009-workflow-ai-authoring` | AI-assisted workflow authoring | 006, 008 |
| `010-workflow-self-service-forms` | Self-service form depth (inputs, encryption, multi-step) | 005, 006 |
| `011-catalog-advanced-properties` | Advanced property types (mirror, calculation, aggregation, timer, embeds) | 001, 005 (aggregation needs the query engine), 006 (timer's |
| `012-scorecards-core` | Scorecards core (rules, levels, entity tab, basic dashboard) | 001, 003, 005 |
| `013-scorecards-integrations-and-groups` | Scorecard groups & third-party compliance automation | 006, 012 |
| `014-governance-and-policy-simulation` | Permission simulator, page ACLs & cross-pillar policy depth | 002, 003, 005, 006 |
| `015-platform-admin-audit-log` | Organization-wide audit log & usage analytics | 001, 002, 006 |
| `016-observability-dogfood` | Observability dogfood (Service/Deployment + full default blueprints) | 001 |
| `017-docs-as-catalog-entities` | Docs as catalog entities | 001, 003 |
| `018-plugins-sandbox` | Plugin sandbox (postMessage, single-HTML artifact) | 003 |
| `019-plugins-marketplace-and-cli` | Plugins CLI, marketplace & management API | 018 |
| `020-dashboards-and-widgets` | Dashboard pages & widget system | 003, 005, 007, 018 |
| `021-integrations-devops-batch` | Integrations batch — Jira Cloud & Azure DevOps | 004, 006, 013 |
| `022-integrations-security-batch` | Integrations batch — security & code-quality tools | 004 |
| `023-integrations-generic-webhook-and-connector-framework` | Generic webhook connector & no-code integration framework | 004 |
| `024-catalog-data-lifecycle` | Catalog data lifecycle — migration, cleanup, export, IaC | 001, 005, 012, 020 |
| `025-sso-and-identity-federation` | Enterprise SSO & identity federation | 002 |
| `026-mcp-server` | MCP server (outward tool gateway) | 001, 002, 006, 012, 017, 018 |
| `027-mcp-connectors-external` | MCP connectors — governed gateway to external MCP servers | 002, 006 |
| `028-ai-agents` | AI agents (governed, catalog-native) | 001, 002, 006, 026 |
| `029-ai-registry-llm-providers` | AI registry — LLM provider abstraction (BYOL) | 002 |
| `030-ai-assistant` | General AI assistant (chat, invoke API, tool approvals) | 001, 002, 003, 006, 017, 026, 029 |
| `031-ai-registry-skills-and-prompts` | AI registry — Skills & Prompts primitives | 004, 017, 026 |
| `032-ai-gateway-governance` | AI Gateway governance | 006, 012, 028, 029 |
| `033-developer-cli` | Tayzu CLI (Go) | 001, 002, 024 |
| `034-notifications-and-slack` | Slack notification & interaction channel | 006, 025 |
| `035-engineering-intelligence-metrics` | Engineering Intelligence & DORA metrics | 004, 012, 020, 021, 022, 031 |
| `036-solutions-resource-management` | Resource Management golden paths (packaged solution) | 006, 010, 021 |
| `037-solutions-autonomous-ticket-resolution` | Autonomous Ticket Resolution (packaged solution) | 001, 004, 006, 011, 012, 022, 028 |
| `038-solutions-self-healing-incidents` | Self-Healing Incidents (packaged solution) | 001, 006, 012, 028, 037 |
| `039-integrations-long-tail-backlog` | Long-tail native-integration backlog | 004, 023 |
| `040-iac-provider` | Terraform provider (Go) for Tayzu resources, with a Pulumi provider generated through pulumi-terraform-bridge (decision D2) | 024, 033 |
| `041-execution-agent` | Self-hosted execution agent: HTTP-polling relay for backends without ingress (decision D3) | 007 |
| `042-multi-org` | Multi-org: organization switcher, account/company admin tiers, multi-org SSO (decision D7) | 002, 025 |
| `043-identity-lifecycle-and-org-admin` | Identity lifecycle and org admin: 4-state user status lifecycle + invitations, service accounts, org API-credentials viewer & rotation, data retention & org deletion (decision D9) | 002 |
| `044-password-reset-and-account-recovery` | Password reset and account recovery: forgot-password email link, single-use short-lived reset tokens, enumeration-resistant responses, session revocation on reset, MFA recovery (decision D10) | 002, 043 |

**Execution order note (2026-09-28):** `002-auth-and-rbac` runs before
`043-identity-lifecycle-and-org-admin`, which runs before
`003-catalog-ui-core` (`002 -> 043 -> 044 -> 003`; `044` was added on the
same day, see D10). The numeric IDs in this table are
labels, not a sequencing rule — `043` was deliberately given a new id instead
of renumbering the rest of the roadmap, and its real execution order is this
dependency chain, not its position in the table.
### Decisiones del roadmap v2 (aprobadas con las opciones recomendadas)

- **D1. Eventos consumibles desde afuera** (equivalente al topic de Kafka de Port): outbox por tenant más endpoint SSE/long-poll sobre el patrón de `catalog_change_event`, dentro de `023`. Sin Kafka.
- **D2. IaC para los recursos de Tayzu**: provider de Terraform en Go (`040-iac-provider`); el de Pulumi se genera con `pulumi-terraform-bridge`. `024` mantiene el export/import.
- **D3. Execution agent** para backends sin ingress: se construye (`041-execution-agent`), relay por HTTP polling sobre los workers.
- **D4. Slack**: `034-notifications-and-slack` completo en la fase 1.
- **D5. Nodos para agentes de terceros** (Claude Managed Agents, Cursor Cloud Agents): incluidos en `028-ai-agents`.
- **D6. Solutions** `037`/`038`: se mantienen en la fase 1, al final.
- **D7. Multi-org**: `042-multi-org` al final. Amplía §6 sin contradecirlo: el aislamiento lógico por `tenant_id` ya lo soporta.
- **D8. JQ en lugar de JSONata** para mappings, condiciones y propiedades calculadas, para que las configuraciones y la documentación de Port sirvan tal cual. Reemplaza al ADR-0002; ver `docs/adr/0012-jq-instead-of-jsonata.md`. `001` no usa ninguno de los dos, así que no se ve afectado.
- **D9. `002`/`043` split: approved (Q1 = b, 2026-09-28).** `002-auth-and-rbac`'s
  original scope was split in two, sized to the roadmap's ~30-80 TDD-task
  budget: `002` keeps the load-bearing baseline (Better Auth, MFA, DB
  roles/RLS, the first HTTP listener, Cerbos wiring + three-tier RBAC +
  moderator + team ownership + dynamic ABAC, machine credentials, the
  `_user`/`_team` system blueprints, the Key Vault seam). The rest —
  4-state user status lifecycle and invitations (with invitation email,
  SEC11), service accounts, the org API-credentials viewer/management, data
  retention & deletion policy + org deletion, and credential-rotation policy
  UX — is the new change `043-identity-lifecycle-and-org-admin` (a new id,
  not a renumbering), which depends on `002` and executes immediately after
  it.
- **D10. `044-password-reset-and-account-recovery`: approved (2026-09-28).**
  The VCDM pre-assessment of `002` (ticket 9) required an explicit scope for
  forgot-password/reset. It gets its own change (a new id, not a
  renumbering), because it sends an emailed link with its own token and
  enumeration risks and `043` is already at 65 tasks. It reuses `043`'s
  email sender and executes right after `043`.
- **D11. Visma Connect SSO moves into `002`: approved (2026-09-28).** Visma
  Connect (OIDC) is Tayzu's own primary human IdP and is added to
  `002-auth-and-rbac`'s scope directly, rather than waiting for
  `025-sso-and-identity-federation`: local email+password and Visma Connect
  SSO both ship in `002`, chosen by the user at sign-in, with explicit
  `sub`-keyed account linking, SSO-aware step-up, and back-channel logout
  (`002`'s `design.md` D22-D26). `025-sso-and-identity-federation` is
  unchanged in scope by this move: it still owns *per-organization* SSO — a
  customer's own SAML/OIDC identity provider, per-tenant enforcement of
  which sign-in methods are allowed, group-sync, and SCIM provisioning —
  none of which this decision adds to `002`.
