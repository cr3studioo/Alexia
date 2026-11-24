# Google

Your Google calendar, Gmail and contacts, for Alexia. It reads your calendar, mail and
contacts, and adds calendar events. Adding an event writes to Google, so Alexia asks you first
whenever she wants to add one on her own. Mail is only read and never marked as read.

Other parts of Alexia (the day planner, the mail desk, memory, the scheduler) use it through
capabilities: `calendar.events`, `calendar.create`, `mail.list`, `mail.read`, `contacts.find`
and `notice.items`. None of them knows it is Google.

## Make your own Google sign-in client (once, free)

Alexia doesn't come with a Google client of its own. You make one in your own Google account,
so only you and this computer can use it.

1. Go to <https://console.cloud.google.com/> and sign in with the Google account you want to
   connect. Create a project (top bar › *New project*). Any name works, for example "Alexia".
2. **Turn on the APIs.** Go to *APIs & Services › Library* and turn on each of these:
   **Google Calendar API**, **Gmail API** and **People API**.
3. **Consent screen.** Go to *APIs & Services › OAuth consent screen* (in newer consoles:
   *Google Auth Platform › Branding / Audience*). Choose **External**, give it an app name and
   your email, and save. Under *Audience › Test users*, **add your own Gmail address**. While
   the app is in *Testing*, only test users can sign in.
4. **Create the client.** Go to *APIs & Services › Credentials › Create credentials › OAuth
   client ID*. Choose **Desktop app** as the application type and create it.
5. Copy the **Client ID** and **Client secret** into Alexia's *Plugins › Google* settings.
6. Press **Connect Google**. Your browser opens Google's sign-in page. Google will say
   **"Google hasn't verified this app"**. That is expected, because the app is your own
   personal client. Choose *Continue*, tick every permission, and allow it. The page then says
   *You can close this tab*, and the plugin's state shows **● Connected**.

If your Alexia can't open the browser itself, the Connect button gives you the link instead.
Open it on this same computer within five minutes.

A note on *Testing* mode: Google may expire a test app's sign-in after about a week. If the
state shows *Google refused the sign-in; connect again*, press **Connect Google** again. Setting
the app to *In production* (*Audience › Publish app*) avoids the weekly expiry. Google still
shows the "unverified" warning, and that is fine for a personal client.

## What it asks for, and why

| Scope | Why |
|---|---|
| `calendar.readonly` | To list the calendars and events you choose. |
| `calendar.events` | To add an event when you ask, or when you say yes to Alexia's suggestion. |
| `gmail.readonly` | To list and read mail. A read-only scope cannot mark mail as read, move it or delete it. |
| `contacts.readonly` | To look up a person's email, phone and birthday. |

A later version adds `gmail.send` and `gmail.compose`, for mail that you approve first. You
will be asked to connect again when that happens.

## How it signs in

- The sign-in uses OAuth with PKCE (S256) and a redirect back to `127.0.0.1`. For a
  short while (until the sign-in comes back, five minutes at most) the plugin listens on one port that the system picks, on
  `127.0.0.1` only. It accepts one request, and only if it carries the random `state` that this
  sign-in made. Then it closes. It never listens on your network.
- The **refresh token** is kept as a password setting, in this computer's keychain or
  Credential Manager. It does not appear on the settings form. The **access token** stays only
  in the plugin's memory.
- Tokens never go into a log, a table, a tool result or a prompt. Errors are short sentences
  and never include Google's reply. Mail and event text is never written to a log.

## Settings

- **Client ID / Client secret**: from step 5.
- **Calendars**: calendar IDs to read, separated by commas. The default is `primary`, your main
  calendar. A calendar's ID is under *Google Calendar › Settings › (the calendar) › Integrate
  calendar*. New events go in the first one listed.
- **Connect Google**: the sign-in button.

## What it says on its own

`notice.items` looks at today and tomorrow, or the scheduler's horizon, and offers:

- each event whose title has a deadline word in it (**Deadline**, **Due**, **Odevzdat**,
  **Termín** or *Termin*, in any case), due at the event's start;
- one quiet line listing today's all-day events: "Today: …".

## Disconnect

1. Go to <https://myaccount.google.com/permissions> (*Third-party apps & services*), find your
   client's app name, and choose **Delete all connections**. The refresh token stops working
   at once.
2. In Alexia, clear the client ID, or disable or remove the plugin. Removing the plugin also
   removes its saved settings, including the stored sign-in.

To remove the client itself, delete it, or the whole project, in the Google Cloud console.
