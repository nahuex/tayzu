# Demo observation template

Copy this file once per demo session, for example to
`demo-observations/2026-10-20-catalog-page.md` outside the repository, or
inside `docs/references/port/` if you want it versioned. Fill it by hand while
you use the demo in a normal browser session. The rows you cover come from
[ui-parity-matrix.md](ui-parity-matrix.md); copy your notes back into that
matrix's "Demo observation" column as a short reference to this session.

## Rules that apply to every session (ADR-0022)

Read [ADR-0022](../../adr/0022-port-public-sources-only.md) before you start.
In short, for humans and agents alike:

- Look at the demo by hand. Write what you see in your own words.
- Do not use REA or any similar tool, CDP or HAR capture, network inspection,
  bundle or source-map analysis, or any automated scraping, crawling or fetching
  of `demo.port.io`, `app.getport.io` or any other Port product host.
- Do not give an agent the demo URL or ask it to open the demo.
- Do not copy Port's code, graphics, logos or other assets, and do not put
  them into Tayzu's product or into this repository.
- Do not record anything that needs a Port account's private data. Use the
  demo's sample data only.
- If the Terms of Service you accepted for the demo limit what you may do with
  what you see, follow them. The legal review of that question is yours
  (ADR-0022, decision 4).

## Session

| Field                           | Value                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Date                            |                                                                                               |
| Observer (name or initials)     |                                                                                               |
| Browser and version             |                                                                                               |
| Screen size and theme           |                                                                                               |
| Demo page or flow               | Your own description, for example "the Services catalog page, then one service's entity page" |
| Matrix rows covered             | Ids from `ui-parity-matrix.md`, for example `22.2`, `22.3`                                     |
| Signed in as (role, if visible) |                                                                                               |

## Observed behaviour, step by step

One line per step. Describe the action you took and what happened. Do not
paste Port text, labels longer than a few words, or code.

| Step | Matrix row | What I did | What happened |
| ---- | ---------- | ---------- | ------------- |
| 1    |            |            |               |
| 2    |            |            |               |
| 3    |            |            |               |

## States and errors seen

Cover what the matrix checklist asks for, and anything else you meet.

| State                       | Matrix row | Where and how it appeared |
| --------------------------- | ---------- | ------------------------- |
| Empty                       |            |                           |
| Loading                     |            |                           |
| Error                       |            |                           |
| Permission denied or hidden |            |                           |
| Validation message          |            |                           |
| Other                       |            |                           |

## Screenshots taken by the human

- Take screenshots yourself with your operating system's tool. Do not use
  automated capture.
- Store them outside the repository by default. List them here by file name and
  where they are kept.
- Only if you want them in the repository: they must be your own screenshots,
  and they are reference notes only. They never become part of Tayzu's product,
  its UI, its docs site assets or its marketing, and they never include Port's
  logo or other brand assets as material to reuse.

| File name | Kept at | Matrix row | What it shows (one line) |
| --------- | ------- | ---------- | ------------------------ |
|           |         |            |                          |

## Open questions

Questions this session raised that the public docs do not answer. Questions
that only the human can decide go to the chat with the agent, as the project
rules require.

1.

## Checklist before you close the session

- [ ] I used only my normal browser, by hand.
- [ ] No tool captured traffic, scripts or the page source.
- [ ] No Port asset was saved into the repository.
- [ ] The matrix rows covered are listed above.
- [ ] My notes are in my own words.
