# ADR-0007: shadcn/ui on Radix UI and Tailwind CSS, with components copied, not installed

- **Status**: Accepted (backfill)
- **Date**: 2026-11-21 (written); decided 2026-09-27, in `openspec/project.md` §2
- **Change**: [`003-catalog-ui-core`](../../openspec/changes/archive/2026-11-27-003-catalog-ui-core/design.md) (design D3, D17; Resolved decisions Q11, Q44, Q94)

This is a **backfill**. The decision has been part of the fixed stack in
`openspec/project.md` §2 since the project started (the "UI components" row
and the ADR-0007 paragraph, line 59), but its ADR file was never written
(`001-catalog-core` ticket T7). `003-catalog-ui-core`, the first change with a
browser app, writes it with the original reasoning and what `003` built on
it.

## Context

Tayzu's web app needs accessible, themeable components (dialogs, menus,
tabs, tables, a command list) in light and dark themes from day one
(`project.md` §5). Port, with a dedicated frontend infrastructure team,
probably builds its design system entirely in house. Tayzu is developed
mostly by Claude Code under human review (`project.md` §10), without such a
team.

The original reasoning in `project.md` §2:

- shadcn/ui is chosen over a fully custom design system built from scratch;
- the shadcn CLI comes with an MCP server
  (`npx shadcn@latest mcp init --client claude`) that gives Claude Code direct
  access to curated components during development, an advantage Port does
  not need but which is decisive here (`project.md` §17 lists the shadcn MCP
  as high priority);
- moving to more custom components later breaks nothing, because shadcn is
  not a runtime dependency: each component's code is copied into the
  repository and fully owned.

`003` also has a strict Content Security Policy (ADR-0026), so the
components must not depend on inline styles or a styling runtime that
inserts `<style>` elements without a nonce.

## Decision

1. **shadcn/ui on Radix UI primitives and Tailwind CSS 4.** The components
   are the shadcn/ui ones, built on individual `@radix-ui/react-*` primitives
   and styled with Tailwind utility classes through
   `class-variance-authority`, `clsx` and `tailwind-merge`. Icons are
   `lucide-react`, bundled. Versions are the ones design D3 pins.
2. **Copied, not installed.** `shadcn` is never a dependency of any package,
   at runtime or build time. Components are copied into
   `apps/web/src/components/ui/` with the pinned CLI
   (`npx shadcn@4.23.0 add <name>`) and from then on are Tayzu source:
   linted, typechecked, tested and changed like any other file. `003` holds
   `alert`, `button`, `command`, `dialog`, `dropdown-menu`, `input`,
   `input-group`, `label`, `table`, `tabs`, `textarea` and `tooltip`.
3. **`apps/web/components.json` records the configuration** the CLI reads:
   style `radix-nova`, base color `neutral` with CSS variables, the Tailwind
   entry `src/index.css` with no prefix and no config file, `tsx: true`,
   `rsc: false`, `lucide` icons, the aliases `@/components`,
   `@/components/ui`, `@/lib/utils`, `@/lib` and `@/hooks`, and no extra
   registry (`registries: {}`). Nothing reads it at runtime.
4. **The CLI output is reviewed and adapted before it is kept** (Q44,
   recorded in `apps/web/CLAUDE.md`), because the 4.23.0 presets pull in what
   this decision excludes:
   - imports use the individual `@radix-ui/react-*` packages, never the
     monolithic `radix-ui` package;
   - `cn` comes from `@/lib/utils` (on `clsx` and `tailwind-merge`), never
     the `cn` npm package;
   - no web font (`@fontsource-variable/geist` is removed): the theme uses
     the operating system's font stack;
   - no `shadcn/tailwind.css` import: the custom variants and the
     `no-scrollbar` utility the components need are copied into
     `src/index.css`, under a comment naming their source (Q44 also asks for
     the MIT notice of that file, which `src/index.css` does not carry yet);
   - every dependency the CLI adds that D3 does not name is removed, the
     rest are re-pinned to D3's versions, and the lockfile diff adds only D3
     packages and their transitive dependencies.
5. **Owned code is changed when Tayzu's rules require it.** The neutral
   theme tokens are adjusted for WCAG 2.2 AA (`--destructive` and the light
   `--muted-foreground` reach 4.5:1 on their tints), and the header
   `DropdownMenu`s are not modal, so a menu never hides focusable controls
   with `aria-hidden` (Q94).
6. **The MCP server is a development aid, not part of the decision's
   footprint.** The repository configures no shadcn MCP server; `003` copied
   its components with the pinned CLI. The copy-not-install rule stands on
   its own.

## Alternatives considered

- **A fully custom design system from scratch**, as Port probably has. This
  is the alternative `project.md` rejects: it needs a dedicated team to build
  and keep accessible what Radix already provides.
- **An installed component library** (for example MUI or Chakra UI). It is a
  runtime dependency that Tayzu cannot change line by line, and both style
  through a CSS-in-JS runtime that inserts `<style>` elements, which
  ADR-0026's `style-src` refuses. Rejected.
- **Radix primitives with hand-written styling, without shadcn.** The same
  primitives, but every component written from nothing. Rejected: more code
  for the same result.
- **Accepting the CLI output as it is** (Q44). It would add a web font, the
  `radix-ui` and `cn` packages and a runtime dependency on `shadcn` itself,
  against this decision. Rejected.

## Consequences

- Tayzu owns the component code. Upstream fixes do not arrive by a version
  bump: a component is refreshed by running the pinned CLI again and applying
  the same adaptation. The Radix primitives and the styling helpers are
  ordinary pinned dependencies that Dependabot bumps.
- Moving to more custom components later is a local change in
  `src/components/ui/`, with no dependency to remove.
- Accessibility of the copied components is Tayzu's responsibility; the axe
  tours of the e2e suite (task 10.9) check it in both themes.
- Every component must work under the strict CSP. Radix's dialog and menu
  scroll lock inserts a `<style>` element at runtime, which is why ADR-0026
  keeps a style nonce; a new component that inserts styles any other way
  fails the e2e CSP check.
- Each `shadcn add` is a reviewed step, not a one-line install, so adding a
  component costs a review of its output and of the lockfile diff.
