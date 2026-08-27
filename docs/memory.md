# What Alexia costs to run

> Measured by [invariant check 9](./spec/invariants.md), which fails the build if core goes
> over budget or an idle plugin turns out to be a running process. The numbers below are
> recorded at each milestone so the **trend** is visible rather than remembered.
>
> Re-measure: `pnpm vitest run --project invariants -t "memory-budget" --reporter=verbose`

---

## The numbers

| Milestone | Date | Machine | Core, alone | One plugin process | Idle plugin |
|---|---|---|---|---|---|
| M0 | 2026-08-27 | Ryzen 5 3600, 16 GB, Windows 11, Node 24.16 | **78.6 MB** | **85.5 MB** (`plugins/hello`) | **no process** |

Budget: core under 150 MB. There is no per-plugin budget, on purpose — see below.

## How they are measured

- **Core, alone** is a process containing core and nothing else
  (`packages/core/test/invariants/core-alone.js`): a store, the plugin registry, an empty
  plugins folder, resident set read after the first allocations settle. Measuring inside the
  test runner would be measuring the test runner.
- **One plugin process** is `plugins/hello` — thirty lines over `@alexia/sdk` — read from
  the OS after its first call: `tasklist` on Windows, `ps -o rss=` everywhere else.
- **Idle plugin** is not a measurement. It is an assertion that there is no process to
  measure: enabled, listed in the library, and not running until something asks it for
  something.

## What the numbers say

**85 MB per plugin process is the honest cost of the architecture**, and it is nearly all
Node's own baseline plus the MCP server and zod. Five plugins running at once would be more
than core itself by a wide margin. That is Alexia.md's risk 2, and there are two answers to
it, both already in the design rather than promised for later:

1. **An idle plugin is not running.** Lazy spawn and idle shutdown mean the steady state on
   a machine with a dozen plugins installed is core plus whatever the user is actually
   using — usually nothing.
2. **A process is what makes a plugin deletable.** The crasher check is the argument: a
   plugin can exit mid-call, wedge itself, or allocate until the runtime kills it, and
   nothing else notices. In-process plugins would cost less memory and the whole thesis.

There is deliberately **no per-plugin budget** in the check. A plugin that loads a speech
model will be far larger than one that greets people, and a number that a real plugin has to
break is a number that gets raised rather than defended. What is defended is that it is not
running when nobody is using it.
