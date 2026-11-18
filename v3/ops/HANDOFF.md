# Handoff · 2026-11-18 · CEO #1 → CEO #2

## Where we are
P0, 16 tasks: merged 1 (P0-01), ready 1 (P0-02), running 0, failed 0, blocked-owner 0, todo 14.

## What I'd do next
1. P0-02 is merged. Next round: P0-03 and P0-04 together (both opus, disjoint paths), as Orca workers.
2. Read CEO.md §15 first: workers are Orca workers now (A-07).
3. Then P0-05/P0-08/P0-09 as deps allow, at most 2 opus per batch.
4. Plan P1 (V3-1) once P0 is mostly merged; G-P0 is a notice only (A-03, no wait).

## Watch out for
- A-05: v3-plan.md is the authority. Put that line in every Planner/Architect/Reviewer prompt.
- INTERFACES.md contradicts v3-plan.md in §5.3, §6 and §7 (see LOG). The specs follow the plan; INTERFACES.md should be corrected by an Architect task.
- P0-16 needs the builder prompt to explicitly allow .github/workflows/v3.yml and v3/ci/ only.
- sqlite-vec may not build with MSVC (P0-04). Some v2 plugins may not start on Windows (P0-15).
- A fast builder (P0-01 took 28 s) still passed review. Always review.

## Open owner asks
- none

## Decisions I made (also in LOG.md)
- Withdrew the gateway "channels" invariant exception; revisit when planning P1, from v3-plan.md.
- P0-16 gets a narrow workflow-path exception.
