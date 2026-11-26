# Computer care (`pc-care`)

Settings, maintenance and power on this computer, Windows or Mac (PC-08, PC-09, PC-10).

| Tool | Capability | What it does |
|---|---|---|
| `system_get` | `system.get` | Reads volume, mute, brightness, dark mode or do not disturb. Read-only. |
| `system_set` | `system.set` | Changes one of them, and answers with the value now in force. |
| `system_care` | `system.care` | Disk space, startup items, waiting updates, old temp files. Destructive. |
| `power_do` | `power.do` | Lock, sleep, restart, shut down, now or in `in_s` seconds. Destructive. |
| `power_cancel` | — | Stops whatever `power_do` has waiting. |

`system_care` and `power_do` are marked destructive as a whole, because a tool has one set of
annotations: their reports and locking are asked about too, although they change nothing.

## What each thing does

- **Temp clean-up** (`check: temp, apply: true`) deletes files in your temp folder that were
  neither created nor changed in the last 7 days and that nothing has open. Folders stay. Links
  and junctions are never followed. A configured "temp" folder that is a drive, holds your home
  folder, belongs to Windows or is not named like one is refused. One run stops after 90 seconds
  and says what is left.
- **Startup** (`check: startup, disable: <name>`) switches off one item. On Windows it writes what
  Task Manager writes, so Task Manager can switch it back on. On a Mac a launch agent is disabled
  with `launchctl` and a login item is removed from the list (the answer gives its path).
- **Updates** are only listed. Nothing is downloaded or installed.
- **Power.** Restart and shutdown wait at least 60 seconds, and sleep at least 5, so the answer
  arrives first. Nothing is forced closed: an app with unsaved work can still stop a restart.
  One action waits at a time. It waits inside this plugin, which therefore stays running
  (`lifetime: resident`); if Alexia quits, or the computer sleeps through the time, the action is
  dropped.

## Limits

- **Do not disturb** (Focus assist) cannot be read or changed by a script on either system.
- **Brightness** works on laptop and other screens Windows can dim (WMI). Desktop monitors
  usually cannot, and a Mac cannot by script.
- Startup items that are scheduled tasks, services or Microsoft Store apps are not listed. Items
  for all users need an administrator to switch off.
- macOS asks you to allow *Automation* (System Events) for dark mode, login items and power, and
  *Accessibility* for locking.
- The Mac side has been tested only against a faked runner.

## Tests

`node --test plugins/pc-care/test`, or `npx vitest run --project unit plugins/pc-care`. Every
program is faked, so no test touches your settings or power. `ALEXIA_PC_LIVE=1` adds live tests
that only read.
