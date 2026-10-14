# ADR-0022: Port is studied through public sources only, never reverse-engineered

- **Status**: Accepted
- **Date**: 2026-10-14
- **Change**: none (a project-wide rule on reference sources; it applies to every
  change that uses Port as its functional reference, first to `003-catalog-ui-core`)

`0019` is reserved for `045-org-deletion-and-data-retention`, so this is the next
free number after `0021`.

## Context

Tayzu is built from scratch and uses Port's publicly documented architecture as its
functional reference (`openspec/project.md`, Section 1). It is not a fork and it
reuses no proprietary Port code. The reference material so far comes from Port's
public documentation, analysed in [`docs/references/port/`](../references/port/README.md).

On 2026-10-14 the human asked whether the reverse-engineering toolkit REA
([`morluto/rea`](https://github.com/morluto/rea), MIT) could speed up an exact
functional copy of Port by analysing the live demo at `demo.port.io`. REA is an MCP
server and CLI. For websites it attaches to a Chrome-family browser over the Chrome
DevTools Protocol and captures the DOM, scripts and network traffic. It can also
analyse JavaScript bundles to recover routes and endpoints, and original sources
when source maps are published.

Three facts decide the question:

- Port's [Terms of Service](https://www.port.io/legal/terms-of-service), read on
  2026-10-14, forbid customers to "reverse engineer or decompile the Services,
  attempt to do so, or assist anyone in doing so". They also forbid customers to
  "copy any features, functions or graphics of the Platform or use it to build a
  competitive product or service".
- REA's own `DISCLAIMER.md` excludes "copying proprietary software or reproducing
  its protected code and assets".
- `openspec/project.md` records that `demo.port.io` blocks automated fetching (bot
  detection). Driving a browser to get around that would be evading a protection
  measure.

## Decision

1. **Allowed sources.** Port is studied only through material Port publishes for
   that purpose, or that anyone may lawfully use:
   - Port's public documentation (`docs.port.io`, including `llms.txt` and the
     public API reference), Port's guides, blog, roadmap and changelog;
   - Port's open-source repositories under their own licenses: for example
     `port-labs/ocean`, the Terraform provider (`port-labs/terraform-provider-port-labs`) and `port-labs/port-plugin-sample`. Their
     schemas and documented behaviour may be cited and summarized. Their code is not
     copied into Tayzu unless its license allows it and the copy is recorded;
   - the human's own observations of the demo, made by hand in a normal browser
     session and recorded as notes and screenshots
     ([`docs/references/port/demo-observation-template.md`](../references/port/demo-observation-template.md)).
2. **Forbidden.** No one working on Tayzu, human or agent, reverse-engineers,
   decompiles or instruments Port's services or the demo. That rules out REA or
   any similar tool, CDP or HAR capture of Port's traffic, bundle or source-map
   recovery, and automated scraping. No one reproduces Port's code, graphics,
   logos or other assets.
3. **Parity is functional and documented.** Each Port capability is mapped in
   [`docs/references/port/ui-parity-matrix.md`](../references/port/ui-parity-matrix.md)
   to its public source, any open-source evidence, the demo observation (if
   any) and the Tayzu change that covers it. Tayzu's own design, code and visual
   identity implement that behaviour.
4. **Legal review is the human's.** The non-compete clause of Port's Terms of
   Service bears on the project's goal of functional parity whenever the human or
   their organization is bound by those terms. That includes holding a Port
   account or using the demo under them. The human decided on 2026-10-14 to take this to legal counsel.
   This ADR does not replace that review, and its outcome may tighten the
   allowed sources above.

## Alternatives considered

- **Use REA (or a browser-automation and capture tool) on `demo.port.io`.** It
  would be faster for exact UI and API shapes, but it breaches Port's Terms of
  Service, REA's own usage policy and `project.md`. It also brings a native
  toolchain (Frida, Ghidra and Hopper bridges) into the development environment.
  Rejected.
- **Use REA only on Tayzu's own software.** This is legitimate and remains
  possible, but it does nothing for Port parity, so it is not part of this
  decision.

## Consequences

- Parity work depends on the quality of Port's public documentation and on
  the human's manual observations. Details that are visible only in the live
  product, such as exact layouts and micro-interactions, come from those notes
  or stay a deliberate Tayzu choice.
- Agents never fetch `demo.port.io`, and no reverse-engineering tool is added
  to the toolchain or the dependency set.
- Every change proposal that cites Port names its public source for each
  behaviour it copies, as `docs/references/port/README.md` already asks.
