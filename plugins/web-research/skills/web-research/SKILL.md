---
name: web-research
description: Use when the user asks to research or investigate a topic, person or username, compare sources, or gather web evidence. Prefer the research tool for these requests; it gathers multiple sources, updates the live Research viewer, and delivers a cited answer and Markdown report.
license: AGPL-3.0-only
---

Use `web-research__research` for a public-web research request, even when ordinary web search tools are also available. It performs discovery, reading and report writing in one call. Individual search calls do not update the Research viewer or produce its report.

Pass a focused question as `query`, preserving names, usernames and contextual clues from the user. Include known public source URLs in `urls` when useful. Set `fresh` to true for news, current facts or an explicit request for fresh information.

The tool returns the final sourced answer and attaches the Markdown report. Deliver that result directly. If it reports insufficient evidence or a failure, preserve that limitation; do not claim the research succeeded. An obscure username with no reliable matches does not establish anyone's identity. Ask for a profile link or another identifying clue when needed.

Research is independent of the viewer. The viewer follows actual work automatically when visible; leave the user's board placement and visibility to them. First use downloads a private runtime and browser and may take a few minutes; subsequent runs reuse them. Never open or control the viewer to start research.
