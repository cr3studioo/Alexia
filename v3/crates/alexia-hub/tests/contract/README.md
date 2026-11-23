# The window contract

One file per area (`gate`, `state`, `chat`, `plugins`, `board`, `library`, `local_models`,
`compute`, `editor`). Each case is a request to the window API and v2's answer to it, as a
*shape*. `tests/contract.rs` replays the cases marked `"hub": "answers"` against the real
`alexia-hub run` and prints the count of `"pending"` ones. `INVENTORY.md` (`v3/specs/P2D/`)
lists the rows; `every_row_has_a_case` fails if one has no case.

```sh
cargo test -p alexia-hub --test contract -- --nocapture     # replay; shows "pending: N"
```

Replay needs no Node and no network. Recording does, and is run by hand.

## A case

```jsonc
{ "row": "A1", "name": "...", "source": "v2" | "hand", "from": "serve.ts:1915-2041",   // from: hand only
  "hub": "pending" | "answers",
  "request": { "method", "path", "query": {}, "body": null | {} | "raw text", "token": true, "host": "127.0.0.1" },
  "setup": ["fresh" | "chat" | "plugins" | "scripted"],
  "response": { "status", "type": "application/json" | null, "shape": <shape> | null,
                "text": "exact body (text/plain)", "ignore": [pointers], "optional": [pointers] },
  "stream": null | [ { "shape": <shape>, "optional": true, "repeat": true, "optional_keys": [...], "ignore": [...] } ],
  "during": [ <request> ],   // sent when the first "ask" frame arrives (C1: /api/approve)
  "behind": <request> }      // a chat left waiting on its ask while this case runs (C1: 423)
```

- **shape**: v2's JSON with each leaf replaced by its type (`"string"`, `"number"`, `"bool"`,
  `"null"`), an object by its key set, an array by the shape of its first element (`[]` if empty).
- **match**: same status, same content type up to `;`, same key set at every object, same leaf
  type, arrays elementwise up to the shorter. `ignore` pointers (`*` = any key or index) are left
  out. A key under an `optional` pointer may be absent, or present when the shape does not list it.
- **stream**: SSE frames in order. `optional` frame may be absent; `repeat` stands for one or more
  in a row (a run of `delta` frames is recorded as one); `optional_keys` / `ignore` are pointers
  inside that frame.
- **setup**: `fresh` empty store; `chat` one session, two messages; `plugins` the `mcp-fixture`
  folder plus a manifest with a widget of every v2 type; `scripted` a fake model that calls one
  tool (a prompt with "ask" calls `set`, which asks first; "work" calls `crunch`, which reports
  progress) and then answers. Cases with the same setup share one hub, in file order.
- **hub**: `pending` is counted, listed and not run. The area task for the row flips it to
  `answers` when its routes answer the case. `record-v2.mjs` keeps this value when it re-records.

## Re-recording

```sh
pnpm install        # once
pnpm typecheck      # builds packages/core/dist, which the recorder boots
node v3/crates/alexia-hub/tools/record-v2.mjs            # rewrite the files
node v3/crates/alexia-hub/tools/record-v2.mjs --check    # re-record into memory, report shape changes
```

The recorder boots v2's `serve()` headless on a scratch folder (secrets in memory, no provider, no
local runtime), sends each request in its `V2` list and writes the shapes. Cases it cannot get an
answer for (a model, a plugin, a GPU, a paired computer, the network) are in its `HAND_RAW` list,
written from the serve.ts / compute/api.ts lines named in `from`; they are kept as they are and
`--check` ignores them. Add a case by adding a line to one of the two lists. Do not change v2 to
make something recordable.

Rows recorded from v2 answer what v2 says to a *fresh* window: most of them are the refusal or the
empty answer, because the success needs a model, a plugin or a paired computer. Those are the cases
the area task has to make answer first; it adds richer `hand` cases beside them as it goes.
