# Shell (`shell-runner`)

Runs commands and scripts, installs programs, and says when a long job finishes (PC-15, PC-16,
PC-17). PowerShell on Windows, zsh on a Mac.

| Tool | Capability | What it does |
|---|---|---|
| `shell_read` | — | Runs a read-only command without asking. Read-only. |
| `shell_run` | `shell.run` | Runs any command. Destructive, open-world: always asked. |
| `software_install` | `software.install` | Installs from winget or Homebrew. Destructive, open-world: always asked. |
| `software_search` | — | Looks a program up. Installs nothing. |
| `job_watch` | `job.watch` | Watches a process or a log file. Never starts anything. |
| `job_unwatch` | — | Stops a watch (and a command started with `watch: true`). |
| `notice_items` | `notice.items` | Finished watches of the last day: "<name> finished (exit N)". |

## What runs without asking

Only `shell_read`, and only when `classify.js` passes the command: its first word (two for git)
is one of `Get-ChildItem, Get-Content, Get-Process, Get-Service, Test-Path, ls, cat, pwd, whoami,
git status, git log, git diff, df, du, ps, uname, which, where`, and the whole command is plain
ASCII letters, digits, spaces and `. _ - / \ : = , + ~ * ? % ' " [ ]`. Everything else, every
Unicode character included, is refused there and has to go through `shell_run`. Also refused:
a network path anywhere in the command (two slashes or backslashes in any mix, so `//srv/share`,
`-Path://srv/share` and `\\srv\share` alike, and `\??\`), and git options that
write a file, run a program, check signatures (`--show-signature`, `%G` formats) or enter
submodules, also when shortened.

Each read-only cmdlet (and in PowerShell `ls`, `cat`, `ps`, `pwd` and `where`, which are cmdlets
there) takes only the named parameters on its own short list. PowerShell takes any unique start
of a name, so a parameter passes only when it starts a listed name and none of `-ComputerName`,
`-Cn`, `-CimSession` or `-Session`: `-C`, `-C:pc`, `-Ci` and `-Se` are all refused.

Read-only git never runs a program the repository names. It runs as `git --no-pager <cmd>
--ignore-submodules=all` (log and diff also `--no-ext-diff --no-textconv`), with no system
settings, no optional locks, no lazy fetch, and settings in its environment, which outrank the
repository's own: `core.fsmonitor=false`, hooks off, pager `cat`, `diff.external` empty,
`log.showSignature=false`, `format.pretty=medium`, and every `gpg.*program` pointed at git
itself. Filter drivers, diff drivers and named formats have names the repository chooses, so
`git config --list -z` is read first (it runs nothing) and each one it names is switched off.

## How a command runs

- The child gets PATH, the home folder, the temp folder and LANG, and on Windows the names Windows
  needs to start a program (SystemRoot, windir, ComSpec, PATHEXT). No `ALEXIA_*`, no secret.
  Installers also get the Windows program and app-data folders.
- `cwd` must be inside the folders the owner opened; without one it runs in the first folder opened, and with none opened nothing runs.
- At most 600 s (120 s by default); on timeout or cancel the whole process tree is killed
  (`taskkill /T` on Windows, the process group elsewhere).
- Each of stdout and stderr is kept to 64 KiB and cut with a note. Output is streamed as
  progress while it runs. **Output is never logged**, only exit codes.

## Installing

winget: `winget search` finds the package, and only one whose id, or else name, is exactly what
was asked for (without case) is taken. Otherwise nothing is installed and the hits are listed with
their publishers. `winget show` gives the publisher, then `winget install --id <id> -e
--source <source> --accept-package-agreements`. Both name the source of the row chosen, so what
is installed is what was shown; when winget does not say the source, nothing is installed. Homebrew: `brew info` decides formula or cask and gives the tap,
then `brew install`.

**The publisher is approved before anything is installed.** `software_install` takes
`publisher`, so it is in the call the owner is asked about. Without it, or when it is not the
package's publisher, nothing is installed and the answer names the publisher, to ask again with.
On a system other than Windows and macOS the tool is still there and answers that installs are
not supported.

## Watches

A file is finished when it has not grown for 60 s, or when a new line contains the `done_when`
text (plain text, case-insensitive, at most 200 characters). It is not a regular expression: a
backtracking pattern could keep the plugin matching one line for minutes. At
most 1 MiB of new lines is read per poll; the rest is read on the next polls. A
process watch has no exit code to report (it is not this plugin's child), so its notice says only
that it finished. Watches live in memory: they end when the plugin stops.
