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
Unicode character included, is refused there and has to go through `shell_run`. Network paths
(`\\server`), `-ComputerName`, and git options that write a file or run a program are refused too;
read-only git runs with `--no-ext-diff --no-textconv` and with the repository's `core.fsmonitor`,
`diff.external` and pager overridden.

## How a command runs

- The child gets PATH, the home folder, the temp folder and LANG, and on Windows the names Windows
  needs to start a program (SystemRoot, windir, ComSpec, PATHEXT). No `ALEXIA_*`, no secret.
  Installers also get the Windows program and app-data folders.
- `cwd` must be inside the folders the owner opened; without one it runs in the home folder.
- At most 600 s (120 s by default); on timeout or cancel the whole process tree is killed
  (`taskkill /T` on Windows, the process group elsewhere).
- Each of stdout and stderr is kept to 64 KiB and cut with a note. Output is streamed as
  progress while it runs. **Output is never logged**, only exit codes.

## Installing

winget: `winget search` finds the package; when several match, nothing is installed and the
choices are listed. `winget show` gives its publisher, then `winget install --id <id> -e
--accept-package-agreements`. The answer names the publisher. Homebrew: `brew info` decides
formula or cask, then `brew install`.

## Watches

A file is finished when it has not grown for 60 s, or when a new line matches `done_when`. A
process watch has no exit code to report (it is not this plugin's child), so its notice says only
that it finished. Watches live in memory: they end when the plugin stops.
