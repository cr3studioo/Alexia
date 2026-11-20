# P1-33: real-message latency run

Status: done (owner decision 2026-11-20: 3 real messages instead of 50)

The owner paired the real Alexia bot on this PC and sent 3 real messages (2 chat, 1 task)
through the v3 hub. `alexia-hub latency --last 50` on the hub's data:

| turn | total | ack |
| ---- | ----- | --- |
| chat 00:49:49 | 3.0 s | 86 ms |
| task 00:52:04 | 6.3 s | 30 ms |
| chat 00:52:25 | 5.6 s | 33 ms |

- Ack under 300 ms on every real message (max 86 ms). This is the P1 promise.
- 87% of total time is the brain (cloud model writing / v2 bridge for tasks), not the hub.
- `--check` refuses with n=3 (needs 50). The 50-run sample was waived by the owner; P1-18's
  automated e2e on the real binary (5/5) covers the repeated-run side.
