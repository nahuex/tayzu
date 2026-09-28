# Port reference material

Analysis of Port's product, used to keep Tayzu an identical functional copy
of Port (`openspec/project.md` §23).

| File                                                         | What it is                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [port-capability-inventory.md](port-capability-inventory.md) | Every capability in Port's documentation (`docs.port.io/llms.txt`, 2026-09-28), grouped by Port pillar, each assigned to a Tayzu change. Appendices: native integrations and out-of-scope items with reasons. |
| [roadmap-analysis.md](roadmap-analysis.md)                   | Per change: scope, the Port capabilities it covers, dependencies and the Port docs to read. Also the old-to-new ID mapping, the coverage check and the decision analysis (D1-D8).                             |

- **Before proposing a change**, read its section in `roadmap-analysis.md`
  and fetch the Port pages it lists fresh (`curl -s https://docs.port.io<path>`),
  because Port changes often.
- **Precedence**: the approved decisions in `openspec/project.md` §23 win
  over the recommendations written inside `roadmap-analysis.md`. That file
  is the analysis as delivered; several of its recommendations (D2-D6, D8)
  were changed by the human toward full parity.
- Both files are generated analysis, not verbatim Port content. They may be
  corrected when Port's docs change; keep the change IDs stable.
