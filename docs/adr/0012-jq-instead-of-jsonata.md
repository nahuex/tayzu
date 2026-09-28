# ADR-0012: JQ instead of JSONata for mappings, conditions and calculated properties

- **Status**: Accepted. Supersedes ADR-0002 (JSONata instead of JQ),
  which is recorded only in `openspec/project.md` §2.
- **Date**: 2026-09-28
- **Decision**: roadmap v2, decision D8 (`openspec/project.md` §23)

## Context

ADR-0002 chose JSONata over JQ for integration mappings and workflow
conditions. Since then the goal of Phase 1 has been made explicit: Tayzu is
an identical functional copy of Port. Port uses JQ everywhere an expression
appears: integration mapping configs, workflow and automation conditions,
calculation properties, dynamic permissions and templated payloads. Its
documentation, examples and community configurations are all written in JQ.

## Decision

Tayzu uses **JQ** as its expression language for every context where Port
uses JQ. The runtime is **`jq-wasm`**, which wraps the official jq 1.8 C
implementation compiled to WebAssembly. It is sandboxed, has no native build
step, and gives the same semantics as the `jq` that Port's examples target.

Expression evaluation always runs with:

- a time limit and an output-size limit, enforced outside the WASM module;
- no access to the environment, the filesystem or the network (`$ENV`,
  `input`, `inputs`, `debug` and `stderr` are disabled or neutralized);
- the expression text treated as untrusted tenant input, validated and
  size-limited before evaluation.

## Alternatives considered

- **Keep JSONata (ADR-0002).** Rejected: every Port mapping, condition and
  example would have to be translated, which breaks the "identical copy"
  goal and doubles documentation work.
- **`node-jq`**: shells out to a native `jq` binary per call. Rejected: a
  process per evaluation, plus a native binary in the supply chain.
- **A pure-JS jq (`jqjs`)**: immature and incomplete. Rejected.

## Consequences

- Integration configs and workflow definitions copied from Port's
  documentation work unchanged.
- `001-catalog-core` is not affected; it evaluates no expressions.
- The sandboxing and limits above become requirements in the changes that
  first evaluate expressions (`004-integrations-sdk-core` for mappings,
  `006-workflow-engine-core` for conditions, `011-catalog-advanced-properties`
  for calculation properties). Their `design.md` must include tests for
  each limit.
