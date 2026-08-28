# Install, enable, disable, delete

Four states and three transitions, and the difference between two of them is the whole
design.

```
       install                enable                 disable
folder ────────> installed ───────────> enabled ────────────> installed
                     │        <────────           <────────
                     │         disable              enable
                     │
                     └──────────────> gone
                             delete
```

## Installed is not enabled

**Installed is files on disk. Enabled is a person having said yes.** A folder appearing in
the extensions directory — put there by the library, by a person, or by something neither
of them noticed — does not start running because it is there.

Between the two, somebody reads your `summary` and every sentence in your `requires[]`, in
your own words, and presses one button. That reading *is* what consent means here.

So: nothing of yours exists until enable. Your tables are created at enable, not at load.
An installed-but-not-enabled plugin owns nothing at all.

## Disable is cheap and delete is not

**Disable** stops your process. Everything you own stays exactly where it is — tables,
settings, your directory, the model that took twenty minutes to download. Changing your
mind about a plugin should cost a click.

**Delete** removes: your process, your namespace, every setting, every keychain entry for a
declared `password`, your own directory, and the folder you were installed from. The screen
puts it one step further back and says what goes before it goes.

## You are not running most of the time

**Lazy spawn is the ordinary state.** An enabled-but-idle plugin runs no process at all —
that is one of the ten invariants, and it is why isolation is affordable. Alexia spawns you
when something is actually asked of you and stops you when you go quiet.

Consequences for you:

- **Do not keep state in memory that you cannot rebuild.** You will be stopped and started.
- **Read your settings on demand**, not once at startup — though caching within a call is
  fine.
- **The settings screen draws itself while you are stopped.** That is why the widget schema
  is in the manifest and why `status` values are remembered by Alexia between your runs.

## Your folder can be deleted while you are running

It is the invariant the whole project reduces to. Two consequences you have to live with:

- **Your working directory is not your folder.** Alexia sets `cwd` to your own data
  directory, because Windows will not let anyone delete a directory a live process sits in.
  Your folder arrives as `ALEXIA_PLUGIN_DIR`, and `readManifest()` reads it for you.
- **A file you read at startup may not be there later.** Read what you need when you need
  it, and fail with a sentence rather than a crash.
