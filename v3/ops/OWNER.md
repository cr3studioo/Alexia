# OWNER

## A-01 · 2026-11-18 · answered
**What I need:** Ops Telegram bot env vars V3_OPS_TG_TOKEN and V3_OPS_TG_CHAT.
**Why:** So headless CEOs can ask and read answers.
**How:** New @BotFather bot; setx both as user environment variables.
**Until then:** OWNER.md only.
**Answer:** Set. New dedicated ops bot @MyAlexia_bot (separate from Alexia's own bot). Test message delivered 2026-11-18.

## A-02 · 2026-11-18 · answered
**What I need:** Pull in the five parked features SP-09, TR-06, TR-14, CO-02, HB-14?
**Why:** v3-plan.md marks them "pull in", owner confirms.
**How:** Yes or no.
**Until then:** n/a
**Answer:** Yes, all five.

## A-03 · 2026-11-18 · answered
**What I need:** How long gate G-P0 waits for review.
**Why:** CEO.md §9.
**How:** A duration.
**Until then:** n/a
**Answer:** No wait. G-P0 is a notice only; carry on immediately.

## A-04 · 2026-11-18 · answered
**What I need:** Acknowledge that the relay runs Claude Code with all permission prompts off.
**Why:** Safety: run it in an account that holds only this work.
**How:** Yes or no.
**Until then:** n/a
**Answer:** Yes, go ahead.

## A-05 · 2026-11-18 · answered
**What I need:** Which document wins when the old docs and the v3 plan disagree.
**Why:** Owner said to ignore what they said about the project before and follow their plan.
**How:** Standing rule.
**Until then:** n/a
**Answer:** v3-plan.md is the authority for scope, crates and tasks. Alexia.md and plan.md count only as facts about how existing v2 code works (wire protocol, data layout), never as what v3 should be. Where they disagree, follow v3-plan.md without raising it as a risk. Tell every Planner, Architect and Reviewer this.

## A-06 · 2026-11-18 · answered
**What I need:** What to do when a usage limit is hit.
**Why:** Owner has banked resets they can use.
**How:** Standing rule.
**Until then:** n/a
**Answer:** When any CEO or worker hits a usage/rate limit, send ONE Telegram message (if the vars are set): "Usage limit hit. Use your banked reset now if you want the build to keep going." Then follow CEO.md §10 as usual (handoff, ALEXIA-CEO: LIMIT).

## A-07 · 2026-11-18 · answered
**What I need:** How workers are run.
**Why:** Owner wants to see the build in the Orca app.
**How:** Standing rule.
**Until then:** n/a
**Answer:** Every worker (Planner, Architect, Builder, Reviewer, Fixer) is a supervised Orca worker started with `orca orchestration worker-start`, never the Agent tool. CEO.md §2, §7, §8 and the new §15 were changed for this with the owner's approval. The relay runs in an Orca terminal and shows each CEO live.
