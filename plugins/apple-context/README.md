# Health and places

A resident Alexia plugin for selected Apple Health data and named-place events.
No proactive messages, hosted backend or paid model calls. Detailed readings stay
in the plugin-owned SQLite database. Model tools and conversation context return
only deliberately selected summaries; exact coordinates and exporter metadata do
not enter those outputs. Existing conversations retain summaries already discussed.

## Compatibility and verification

Adapter target: Hozz **v0.1.0-beta.1**, lossless JSON or NDJSON, schemaVersion 1.
Source contract: https://github.com/brandomoore/Hozz/blob/v0.1.0-beta.1/docs/delivery-schema.md
TestFlight: https://testflight.apple.com/join/y7K4DAdF

The release documentation and tagged source were inspected. The installed iPhone
beta and physical Watch have **not** been tested here. The owner explicitly moved
that test to final acceptance. Newer Hozz schema versions are refused. Tests use
synthetic records, not personal health data. TestFlight builds expire and depend
on the maintainer publishing updates; this integration cannot guarantee their
future availability. No paid exporter is silently substituted.

## Setup, in order

1. Install this plugin through Plugins → Add a plugin (the local plugin folder
   when developing). Enable it after reading the permissions. For a source checkout,
   run `pnpm install` and `pnpm typecheck` first.
2. In iCloud Drive, create `Shortcuts/Alexia/events` and `Shortcuts/Alexia/health`.
   Add the `Alexia` folder to Alexia's allowed folders. Set **iCloud inbox folder**
   to its actual absolute path; Finder's Copy as Pathname avoids guessing the
   iCloud container. Choose **Keep Downloaded** on that folder where available.
3. In the plugin settings confirm your timezone, phone identifier (`my-iphone` by
   default), and named-place labels. Labels should be Home/Gym/Work, not addresses.
   The folder must remain within the currently allowed roots. Revoking scope stops
   imports and cleanup. Pending cloud files are retried; a supplied Swift helper
   requests their download on macOS when command-line Swift is available.
4. Install the Hozz beta on your iPhone and authorize only workouts, sleep,
   steps, active energy, Apple exercise time, resting heart rate and HRV (SDNN).
   Configure a **Folder** destination pointing to `health/`, lossless NDJSON.
   Select the previous year if the beta exposes a date selector. Otherwise its
   automatic history sweep can be larger: Alexia imports only the last 365 days,
   but the transport may temporarily use more iCloud space. Prefer a date-bounded
   manual lossless export for the initial year and incremental automatic delivery.
   Do not use CSV, Metrics JSON, ZIP or Health Auto Export compatibility mode.
   Unzip a manual archive and place only its NDJSON data file in `health/`.
5. Run a small manual Hozz sync. Click **Check inbox now**. Confirm the Health
   panel shows correct dates and values. Coverage without an `anchorClosed`
   report remains incomplete; an empty import is not evidence of inactivity.
6. To enable direct delivery, generate two different secrets, e.g. by running
   `openssl rand -hex 32` twice on your Mac. Paste them into the two password
   settings. Alexia stores them in its OS keychain. Keep the Shortcut token private;
   it will also live in your configured Shortcut. Enable **private direct delivery**.
   The **Local receiver** setting shows the persisted loopback port. If that port
   is occupied, stop the competing process; the plugin does not silently change it
   and leave Tailscale pointing at the wrong service.
7. Install Tailscale on phone and Mac and sign into the same personal tailnet.
   Review `tailscale serve status` before adding a mapping. Use an unused private
   HTTPS port, for example:

   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:PORT
   ```

   Replace PORT with the plugin's displayed port. Use the HTTPS address Tailscale
   prints, including `:8443` if present. This is **Serve**, not public Funnel.
   Only the receiver port is exposed, never Alexia's main API. Restrict the
   tailnet's access policy to your phone and Mac if other users share it.
8. Add a second Hozz destination: **Web address**, the printed HTTPS address plus
   `/v1/health/hozz`, lossless NDJSON, Authorization set to `Bearer YOUR_HEALTH_TOKEN`.
   Retain the folder destination. Both paths converge on the same record identities.
   Batches must be at most 8 MiB/50,000 records; configure smaller delivery batches
   if necessary. A rejection leaves the source responsible for retrying.
9. Press **Get iPhone shortcuts**, then import and configure the supplied templates as described in
   [Shortcuts setup](assets/shortcuts-setup.md). Run each manually once before
   connecting its personal automation. Apple may require permission prompts.
10. Once a full round trip works, enable **Clean acknowledged inbox files after
    seven days**. This is opt-in because it deletes user-owned transport files.
    Only a stable file with a matching imported hash is eligible. Keep your Health
    source and any independent backups; the inbox is a queue, not a backup.

No iCloud upgrade is required by the software. If your existing quota fills up,
file delivery stops: reduce exported categories/backfill or free space. Tailscale
Personal is free for personal use under its current terms. Its coordination
service and Apple's iCloud are not fully self-hosted open-source infrastructure.

## Data and controls

- Initial/rolling detailed history: 365 days. Older detail is removed, while dated
  daily summaries remain. Weekly summaries are calculated from those daily rows.
- Coordinates from an explicitly run snapshot never appear in tools and are
  removed from the active database within 24 hours plus the hourly maintenance
  interval. Receipt files on iCloud follow the separate seven-day cleanup policy.
- Source choice is per local calendar day and metric: Watch, iPhone, then another
  source in stable identifier order. **Preferred sources** can override a metric,
  e.g. `{"steps":"com.example.tracker"}`. Source selection avoids cross-device
  addition; it is not an exact implementation of Apple's private Health totals.
- Sleep is unioned elapsed sleep, excluding in-bed/awake categories, and allocated
  across local calendar days. DST changes elapsed time, not the clock labels.
- “Latest received workout” is not necessarily the latest workout in Health.
- A workout-end event is linked only if exactly one workout ends within five
  minutes. Otherwise details remain pending or ambiguous.
- Current-context emphasis for workout-end events lasts two hours. Place arrivals
  older than two hours are explicitly last reported; departure clears presence.
- Set **Pause incoming data** to stop both paths. Disable **private direct delivery**
  to close the listener. Turn off Hozz destinations/Shortcuts to disconnect the phone.
- Change a receiver password to revoke that token, then update its sender.
- **Forget selected range** suppresses reimport as well as deleting local records
  and derived summaries. It does not erase old conversation transcripts or source
  Health/iCloud data. **Allow forgotten data to be imported again** clears those
  suppression rules; do this deliberately.
- Disabling the plugin stops processing but preserves local history. Removing it
  purges its data and settings. Remove only the Tailscale mapping you created
  (`tailscale serve --https=8443 off` in the example), and separately remove phone
  automations/destinations if desired. No unrelated Tailscale settings are reset.

## Wire interfaces

POST `/v1/events`: event-token Bearer authentication, at most 16 KiB, schema below.
POST `/v1/health/hozz`: separate health-token Bearer authentication, at most 8 MiB,
Hozz v1 lossless JSON array or NDJSON. GET `/v1/status`: event token, status only.
Replies acknowledge a durable SQLite commit. Replays return `duplicate`.
Invalid input returns 422; unknown schemas are left in the inbox for review.
No payloads or credentials are logged.

```json
{"schemaVersion":1,"eventId":"unique-per-occurrence","deviceId":"my-iphone","type":"place.arrived","occurredAt":"2026-10-23T10:00:00Z","payload":{"placeId":"gym"}}
```

Events: `workout.ended`, `place.arrived`, `place.left`, `location.snapshot`.
IDs must be unique per occurrence and reused across transports. Generated
Shortcuts use a timestamp plus two random components, rather than depending on
an additional app for UUID generation. Timestamps carry an explicit UTC offset.
Health revisions/deletions use Hozz canonical identities and record versions.

Tools: `recent_activity`, `workout_history`, `health_trends`, `place_history`,
`sync_status`. Optional `context.current` supplies bounded summary context at
conversation start. Nothing launches an agent task on event receipt.

## Acceptance checklist (physical devices still required)

- [ ] Verify Hozz beta version and export schema match this adapter.
- [ ] Workout end with phone unlocked, then locked: event arrives; details can lag.
- [ ] Cellular + Tailscale: direct delivery; Tailscale off: iCloud catch-up.
- [ ] Sleeping Mac: no immediate processing, correct catch-up after waking.
- [ ] Same event through both transports produces one event.
- [ ] Arrival then departure shows the expected label and clears presence.
- [ ] Czech locale snapshot and ISO timestamp parse correctly.
- [ ] Historical queries return sensible values; missing coverage stays explicit.
- [ ] Forget a range, resync, restart: forgotten data remains absent.
- [ ] Record occurrence time, receipt time and time details became available.

Run automated checks with `pnpm exec vitest run --project unit plugins/apple-context`
and the generic core context tests. No physical-device test is claimed by these.
