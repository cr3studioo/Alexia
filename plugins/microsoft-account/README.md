# Microsoft 365

Your Outlook calendar, mail and contacts, for Alexia. It works with a personal Microsoft
account (Outlook.com, Hotmail, Live) and with a school or work Microsoft 365 account. It reads
your calendar, mail and contacts, and adds calendar events. Adding an event writes to
Microsoft, so Alexia asks you first whenever she wants to add one on her own. Mail is only
read and never marked as read.

Other parts of Alexia (the day planner, the mail desk, memory, the scheduler) use it through
capabilities: `calendar.events`, `calendar.create`, `mail.list`, `mail.read`, `contacts.find`
and `notice.items`. None of them knows it is Microsoft.

## Register your own app (once, free)

Alexia doesn't come with a Microsoft app of its own. You register one, so only you and this
computer use it. It is a *public client*: it has no secret, and nothing to keep safe but its ID.

1. Go to <https://entra.microsoft.com/> and sign in. If your personal account has no directory
   there, Microsoft offers to create one for free (a free Azure account does this too).
2. Go to *Identity › Applications › App registrations › New registration*.
   - **Name**: anything, for example "Alexia".
   - **Supported account types**: *Accounts in any organizational directory and personal
     Microsoft accounts*. That lets one app connect both kinds of account.
   - **Redirect URI**: leave it empty. The device code sign-in doesn't use one.
   - Press **Register**.
3. **Allow the device code sign-in.** In the new app go to *Authentication*, scroll to
   *Advanced settings*, set **Allow public client flows** to **Yes**, and save.
4. **Permissions.** Go to *API permissions › Add a permission › Microsoft Graph › Delegated
   permissions* and add `Calendars.ReadWrite`, `Mail.Read`, `Contacts.Read`, `User.Read` and
   `offline_access`. You don't need to grant admin consent for your own personal account. You
   approve them yourself when you sign in.
5. On the app's *Overview* page, copy the **Application (client) ID** into Alexia's
   *Plugins › Microsoft 365 › Application (client) ID*.
6. Leave **Tenant** as `common`, unless your school or company tells you to use its own
   domain (for example `school.edu`) or tenant ID.
7. Press **Connect Microsoft**. Alexia shows a short code and a page,
   <https://microsoft.com/devicelogin>, both in the plugin's state and in the chat. Open the
   page on any device, type the code, sign in with the account you want to connect, and allow
   what it asks. The state then shows **● Connected**. The code works for about fifteen
   minutes. Press Connect again for a new one.

### School and work accounts

An organisation decides which apps may read its accounts. Many schools allow you to consent
to an app like this one yourself. Some require their IT to approve it first, and some refuse
outright. When the organisation says no, the state says:

> Your organisation does not allow Alexia to connect. Ask its IT, or use a personal account.

Alexia can't get around that, and won't try. Ask IT to approve your app (they need its
client ID), or connect a personal account instead.

## What it asks for, and why

| Permission | Why |
|---|---|
| `Calendars.ReadWrite` | To read your calendar, and to add an event when you ask, or when you say yes to Alexia's suggestion. |
| `Mail.Read` | To list and read mail. A read permission can't mark mail as read, move it or delete it. |
| `Contacts.Read` | To look up a person's email, phone and birthday. |
| `User.Read` | Microsoft's basic sign-in permission. Every app asks for it. |
| `offline_access` | So the sign-in lasts, and you don't have to connect again every hour. |

A later version adds `Mail.Send`, for mail that you approve first. You will be asked to
connect again when that happens.

## How it signs in

- It uses Microsoft's **device code** sign-in. Alexia asks Microsoft for a code, shows you the
  short user code and the page, and asks Microsoft at the interval it gives (every few seconds)
  whether you have finished. It stops when you finish, when you say no, or when the code runs
  out. Pressing Connect again starts over.
- Nothing listens on this computer. The plugin only talks out, to `login.microsoftonline.com`
  and `graph.microsoft.com`.
- The **refresh token** is kept as a password setting, in this computer's keychain or
  Credential Manager. It doesn't appear on the settings form. Microsoft sometimes hands out a
  new one when the old one is used, and the plugin keeps the newest. The **access token** and the
  **device code** stay only in the plugin's memory.
- Tokens and the device code never go into a log, a table, a tool result or a prompt. Errors
  are short sentences and never include Microsoft's reply. Mail and event text is never
  written to a log.

## What it reads

- **Calendar**: the account's default calendar, recurring events expanded. Times come back in
  UTC, and all-day events come back as days.
- **Mail**: every folder, newest first. Labels say `UNREAD`, `INBOX`, `SENT`, `DRAFT`,
  `IMPORTANT`, `FLAGGED`, `OTHER` (outside the Focused inbox), and your categories. A search
  uses Outlook's own search words, for example `from:school` or `subject:invoice`.
- **Contacts**: by the start of a first, last or full name, by an exact email address, or by
  phone number. A phone search reads through your contacts, up to a thousand of them.

## What it says on its own

`notice.items` looks at today and tomorrow, or the scheduler's horizon, and offers:

- each event whose title has a deadline word in it (**Deadline**, **Due**, **Odevzdat**,
  **Termín** or *Termin*, in any case), due at the event's start;
- one quiet line listing today's all-day events: "Today: …".

Its keys start with `microsoft:`, so they never collide with another plugin's.

## With the Google plugin as well

Both account plugins can be enabled at once. Then:

- **`notice.items` comes from both.** The scheduler asks every provider, so deadlines on
  either calendar are raised.
- **`calendar.events`, `calendar.create`, `mail.list`, `mail.read` and `contacts.find` go to
  one of them: the one installed first.** Asking for "my calendar" reads that account, and new
  events go there. To make the other one answer, disable the first.

## Disconnect

1. For a personal account, go to <https://account.live.com/consent/Manage>. For a school or
   work account, go to <https://myapps.microsoft.com/> and choose *Manage your applications*.
   Find your app and remove it. The refresh token stops working at once.
2. In Alexia, clear the client ID, or disable or remove the plugin. Removing the plugin also
   removes its saved settings, including the stored sign-in.

To remove the app itself, delete it under *App registrations* in the Entra admin center.
