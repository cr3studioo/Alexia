# The cold-install test

> **The commitment:** sit a real person in front of Alexia at every milestone, time them,
> and **do not help**.
>
> Ease of setup is the pitch. It is also the one claim in this project that cannot be
> verified by a test, a benchmark or an opinion — only by watching somebody struggle. This
> document exists because a commitment that lives only in someone's head is a commitment
> that quietly stops happening around M3.
>
> Results: [`test/cold-install/results.md`](../test/cold-install/results.md). **Appended,
> never edited.** The value is entirely in the trend across milestones.

---

## When

| Test | Milestone | What they are given |
|---|---|---|
| #1 | M1-13 | whatever exists — a terminal command is acceptable here and nowhere later |
| #2 | M2-8 | the crude installer |
| #3 | M3-8 | the installer, plus installing one plugin from the library |
| #4 | M5-6 | **the real one.** A signed installer, and they must never see a terminal. |

Each is a `[GATE]`. The build does not move past one until it has happened.

---

## Who

**Someone specific and known**, not a demographic — the person named in Alexia.md's *There
is a real person to test on*. Reusing the same person across milestones is the point: the
trend is the measurement, and a new person each time measures nothing but variance.

They will get better at it over four tests. That is fine, and it is why the *hesitations*
column matters more than the clock. A step that stops producing hesitations has genuinely
been fixed. A step that produces the same hesitation at M2 and again at M5 has been
rationalised, not fixed.

---

## The protocol

### Before

1. A machine that has never had Alexia on it. Not yours. If it must be yours, a fresh user
   account and a check that no `%APPDATA%`/`~/.config` leftovers survive.
2. Note the machine: OS version, RAM, GPU, whether Node/Python/Ollama happen to be
   installed. **The tester's machine is the one that matters**, not the development one.
3. Have a stopwatch and this document open. Have the results file open in a second window.
4. Decide the finish line in advance and write it down: *"a reply, on screen, that they
   asked for."*

### What you say

> Nothing.

Hand them the installer. Say *"see if you can get this working."* Then stop talking.

### When they ask you something

**Say nothing.** Not "have a look around", not "what do you think it does" — those are
hints wearing a costume, and they contaminate the only data this test produces.

The single permitted intervention is when they are genuinely stuck and about to give up,
and it ends the test:

> "That's the end of the test — thank you. Can you tell me what you were expecting there?"

**Write down that they got stuck, at which step.** A test that ends early is not a failed
test. It is the most useful result this exercise produces, and reporting it as anything else
makes every future test worthless.

### What you record

**The clock,** at these points, every time, so the columns line up across milestones:

| Marker | Stop the clock when |
|---|---|
| `t_first_screen` | the first Alexia window is visible |
| `t_name` | the name step is done |
| `t_mode` | the mode step is done |
| `t_provider` | a provider is connected, or the model download finishes |
| `t_first_reply` | **the first reply they asked for is on screen** |

**Every hesitation, verbatim.** Their words, not your summary of them. *"Is this the one I
want?"* is data. *"User was unsure about the mode selection"* is your interpretation of the
data, and by the next milestone it will be all you have left.

Record a hesitation whenever they:

- pause for more than about five seconds without moving,
- re-read something,
- move the pointer somewhere and then away again,
- say anything at all,
- click the wrong thing.

**Where they went instead.** If they open the wrong screen, note which one. Wrong turns say
more about the design than the right ones do.

### Afterwards

Ask exactly two questions, in this order, and write the answers verbatim:

1. *"What did you think it was going to do?"*
2. *"Was there anywhere you weren't sure what to do next?"*

Then append to [`results.md`](../test/cold-install/results.md). Append — never edit an
earlier entry, not even to fix a typo. An edited log is a log you cannot trust, and the whole
point is the comparison.

---

## Reading a result

The budget, from Alexia.md's *First run, end to end*:

| Mode | `t_first_reply` |
|---|---|
| Combined | **under 2 minutes** |
| Cloud | under 2 minutes |
| Local | **under 5 minutes**, and only because of the model download |

A number over budget is a task. A number under budget with four hesitations in it is also a
task, and the more urgent one — they got there, but they got there by guessing.

**Do not fix anything during the test, and do not fix anything the same day.** Write it down,
finish the session, and let the list be the list. The temptation to patch the thing you just
watched somebody trip over is the fastest route to a build that is optimised for one person's
last five minutes.
