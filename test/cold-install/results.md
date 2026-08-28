# Cold-install results

> **Appended, never edited.** Not even to fix a typo. The value of this file is entirely in
> the comparison between rows, and an entry someone went back and tidied is an entry nobody
> can trust.
>
> Protocol: [`docs/cold-install.md`](../../docs/cold-install.md). One section per test,
> newest at the bottom.

## The clock

Times are from the moment the installer is double-clicked. `—` means the step did not exist
in that build. `stuck` means the test ended there.

| Test | Date | Milestone | Tester | Machine | Mode | `t_first_screen` | `t_name` | `t_mode` | `t_provider` | `t_first_reply` | Hesitations | Ended |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | |

*(No tests yet. The first is [`M1-13`](../../plan.md).)*

## Hesitations, verbatim

Their words, not a summary. One line each, tagged with the test number and the step it
happened on.

| Test | Step | What they said or did |
|---|---|---|
| | | |

## Afterwards

The two questions, verbatim.

| Test | "What did you think it was going to do?" | "Was there anywhere you weren't sure what to do next?" |
|---|---|---|
| | | |

---

## Test 1 — did not happen

**2026-08-28 (D64).** M1-13 was ticked as **waived**, not passed. No tester sat down, no clock
ran, and nothing above this line was filled in — the tables are still empty on purpose, and the
first data row in them will be **M2-8**, run against an installer.

Reason, recorded so the gap in the trend is readable later: the build at M1 has no installer,
so the protocol's clock cannot start where it is defined to start, and the owner chose to spend
the time on M2 instead. What the test would have measured most cheaply — what a person does when
told to go and make an OpenRouter account — is still unmeasured.

The state of the build at the moment of waiving, for whoever compares M2-8 against it: first run
is steps 2, 3 and 4a only, Local mode dead-ends with no step 4b, and the visual language is
M1-D1's holding theme — one dark achromatic palette, her face as the mark — with the full design
pass still ahead at M2-D1.
