# Phone automation setup

Press **Get iPhone shortcuts** in the plugin settings to download eight signed templates: Workout ended,
Location snapshot, and Home/Gym/Work arrival and departure. The downloaded `.shortcut` files are signed import candidates. The repository retains
`.unsigned.shortcut` source plists and `.signed.b64` encoded signed artifacts. They contain setup markers, not working credentials.

## Configure each imported shortcut

1. Download the files from **Get iPhone shortcuts**, then open each signed file on your iPhone (AirDrop or iCloud Files → Share → Shortcuts).
2. Read its introductory comment. In the Text action set `deviceId` to the exact
   phone identifier in Alexia. Named-place templates already set `placeId` to
   `home`, `gym`, or `work`; those must exist in Alexia's Places JSON.
3. In **Save File**, choose the existing iCloud Drive
   `Shortcuts/Alexia/events` folder, turn **Ask Where to Save** off and leave
   overwrite off. The preceding Set Name action supplies the unique `.json`
   filename. Apple folder bookmarks cannot be preconfigured for another account;
   remove an extra destination subpath if choosing the folder already supplies it.
4. In **Get Contents of URL**, replace the example address with your private
   Tailscale Serve address plus `/v1/events`. Keep method POST and request body
   **File**, using the output of Set Name. Keep Content-Type `application/json`.
   Replace the Authorization value with `Bearer ` followed by your event token.
5. Run once manually. Grant file/network/location permissions as requested.
   Confirm an event JSON file exists and Alexia imports it. Check the direct
   response is accepted or duplicate. Never share a shortcut after adding a token.

Saving happens before HTTP. When the receiver is offline, Shortcuts may display a
network error; the saved file is still queued for iCloud delivery. There is no
retry loop that keeps the phone awake. If Save File itself fails, the shortcut
stops: fix iCloud permissions/quota before relying on it.

## Add personal automations

These bindings must be created on your phone; importing a Shortcut does not
silently install an automation.

- **Apple Watch Workout → Ends → Any Workout → Run Immediately**: run
  `Alexia - Workout ended`.
- Create a **second independent Workout Ends automation**: run Hozz's
  **Sync Health Data** action. Do not append it after the event sender's HTTP call,
  because a failed HTTP request would prevent the Health sync.
- **Time of Day → daily at 09:00 → Run Immediately**: run Hozz's Sync Health Data
  as a catch-up attempt. Keep Hozz background syncing enabled too.
- **Arrive** at each selected place: run its `arrived` shortcut.
- **Leave** each selected place: run its `left` shortcut.
- Run `Alexia - Location snapshot` explicitly when desired. It reads coordinates;
  Alexia stores these locally for the short retention window and does not claim
  a live map feature. It never runs continuous GPS tracking.

To add another named place, duplicate an arrival/departure shortcut, change its
placeId, add the same id/label in Alexia, and create the two phone automations.

## Template rebuild and verification

Run `python3 assets/build-shortcuts.py` from the plugin folder. Run `python3 assets/sign-shortcuts.py` on macOS to update the encoded signed artifacts.
It invokes Apple’s `shortcuts sign` using temporary output files.
Signing sends the unconfigured template to Apple's signing service. Do not sign
or distribute a file containing real tokens. The generated workflow format is
validated structurally; import, action migration, location number formatting and
execution on the owner's iOS version remain part of physical-device acceptance.
