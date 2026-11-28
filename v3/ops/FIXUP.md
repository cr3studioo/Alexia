# FIXUP: known bugs to fix after the one big build (A-30 fast mode)

One line each. The fix-up round after the build takes these too.

- P4-06 link.rs:316,323-327: HOSTS keyed by endpoint id, never cleared; after Node::close + start in one process the old Host (dead Weak) answers 503. Key by Arc ptr / drop in close / rebuild on failed upgrade.
- P4-06 link.rs:392-393: accept() continues on every listener.accept() error, spins at 100% CPU on a lasting error. Back off.
- P4-06 tests/link.rs: link tests never run (memory); run them 3x.
- P4-05/P4-04 control.rs ~140: SSE from_utf8_lossy per chunk mangles split multibyte chars.
- P3-42 leftovers: commands.rs:988, hub main.rs:1284, api board.rs:1309 still treat open_world as == Some(true).
- Scheduler tests cancel_stops, fires_through_brain_and_says depend on the clock (Evening wrap-up 21:00).
- mcp tests (trust_makes_tools_reviewed, servers_persist, add_server_hosted_unreviewed, tools_carry_device) fail when the target is on another drive than the repo.
