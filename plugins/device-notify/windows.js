// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { cut, wantsAnswer } from './notify.js'

/**
 * Windows: a toast through PowerShell's WinRT projection, under PowerShell's own AppId (a
 * toast needs an app registered in the Start menu, and PowerShell is one on every machine).
 *
 * The script is a constant. The notice reaches it on stdin, as base64 of UTF-8 JSON, so no
 * code page can change it and no character of it is ever part of the code. The toast itself is
 * XML built here, every value escaped; a button's `data` is not in it at all (the toast says
 * `b0`, and `notify.js` looks the data up).
 *
 * **The Activated event.** Windows PowerShell cannot subscribe to a WinRT event
 * (`Register-ObjectEvent` refuses), so the script compiles a few lines of C# that can, in the
 * same process. It goes through the .NET compiler directly because `Add-Type` cannot take a
 * `.winmd` reference.
 */

const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** A toast's whole payload is limited to about 5 KB, so it is cut well short of that. */
const MAX_TITLE = 150
const MAX_TEXT = 800
/** The script's own limit is this much past the caller's, so the caller's clock decides. */
const SLACK_MS = 5_000

const EVENTS = `
using System.Threading;
using Windows.UI.Notifications;
public static class AlexiaToast {
  static readonly ManualResetEvent Done = new ManualResetEvent(false);
  static string[] result;
  static void Finish(string[] r) { if (Interlocked.CompareExchange(ref result, r, null) == null) Done.Set(); }
  public static void Watch(ToastNotification toast) {
    toast.Activated += (sender, e) => {
      var activated = e as ToastActivatedEventArgs;
      string reply = null;
      if (activated != null && activated.UserInput != null) {
        object typed;
        if (activated.UserInput.TryGetValue("reply", out typed)) reply = typed as string;
      }
      Finish(new string[] { "activated", activated == null ? "" : activated.Arguments, reply });
    };
    // TimedOut is only the popup moving to the notification centre, where it can still be answered.
    toast.Dismissed += (sender, e) => {
      if (e.Reason != ToastDismissalReason.TimedOut) Finish(new string[] { "dismissed", "", null });
    };
    toast.Failed += (sender, e) => { Finish(new string[] { "failed", "", null }); };
  }
  public static string[] Wait(int ms) { Done.WaitOne(ms); return result; }
}
`

/** Prints one JSON line per thing that happened. A failure is named by its type, never its message. */
export const SCRIPT = `
$ErrorActionPreference = 'Stop'
function Say($line) { [Console]::Out.WriteLine(($line | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  $raw = [Console]::In.ReadToEnd().Trim()
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)) | ConvertFrom-Json
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml([string]$request.xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  if ($request.tag) { $toast.Tag = [string]$request.tag; $toast.Group = 'alexia' }
  $events = $null
  if ($request.waitMs -gt 0) {
    $source = @'
${EVENTS}
'@
    $options = New-Object System.CodeDom.Compiler.CompilerParameters
    $options.GenerateInMemory = $true
    $winmd = Join-Path $env:SystemRoot 'System32\\WinMetadata'
    foreach ($reference in @(
      'System.dll',
      [Reflection.Assembly]::LoadWithPartialName('System.Runtime').Location,
      [Reflection.Assembly]::LoadWithPartialName('System.Runtime.InteropServices.WindowsRuntime').Location,
      (Join-Path $winmd 'Windows.UI.winmd'),
      (Join-Path $winmd 'Windows.Foundation.winmd'),
      (Join-Path $winmd 'Windows.Data.winmd')
    )) { $null = $options.ReferencedAssemblies.Add($reference) }
    $built = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($options, $source)
    if ($built.Errors.HasErrors) { Say @{ failed = 'the event handler did not compile' }; exit 1 }
    $events = $built.CompiledAssembly.GetType('AlexiaToast')
    $events::Watch($toast)
  }
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}')
  if ("$($notifier.Setting)" -like 'Disabled*') { Say @{ failed = 'disabled' }; exit 0 }
  $notifier.Show($toast)
  Say @{ shown = $true }
  if ($null -eq $events) { Start-Sleep -Milliseconds 500; exit 0 }
  $result = $events::Wait([int]$request.waitMs)
  if ($null -eq $result) { exit 0 }
  if ($result[0] -eq 'activated') {
    $typed = ''
    if ($result[2]) { $typed = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result[2])) }
    Say @{ action = $result[1]; text = $typed }
  } elseif ($result[0] -eq 'dismissed') {
    Say @{ action = 'close' }
  } else {
    Say @{ failed = 'Windows did not show it' }
  }
} catch {
  Say @{ failed = $_.Exception.GetType().Name }
  exit 1
}
`

/** Characters XML 1.0 cannot hold in any form, half a surrogate pair among them. */
const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const xml = (value) => value.replace(NOT_XML, '').replace(/[&<>"']/g, (c) => ENTITIES[c])

/** The toast for a notice. Urgent plays the default sound; the others are silent. */
export function toastXml(notice) {
  const asks = wantsAnswer(notice)
  // A reminder stays on screen until it is dealt with; it needs a button, which asking gives it.
  const stays = asks && (notice.urgency === 'high' || notice.urgency === 'urgent')
  const attributes = `launch="body"${asks ? ' duration="long"' : ''}${stays ? ' scenario="reminder"' : ''}`
  const actions = [
    ...(notice.reply ? ['<input id="reply" type="text" placeHolderContent="Reply"/>'] : []),
    ...notice.buttons.map((b, n) => `<action content="${xml(b.label)}" arguments="b${String(n)}" activationType="foreground"/>`),
    ...(notice.reply ? ['<action content="Send" arguments="send" activationType="foreground"/>'] : []),
  ]
  const audio = notice.urgency === 'urgent' ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>'
  return (
    `<toast ${attributes}><visual><binding template="ToastGeneric">` +
    `<text>${xml(cut(notice.title, MAX_TITLE))}</text><text>${xml(cut(notice.text, MAX_TEXT))}</text>` +
    `</binding></visual>${actions.length > 0 ? `<actions>${actions.join('')}</actions>` : ''}${audio}</toast>`
  )
}

/** Windows keeps a toast tag to 64 characters, so an id of any shape becomes a short hash. */
const tagFor = (id) => createHash('sha256').update(id).digest('hex').slice(0, 32)

/** Windows' own PowerShell, by absolute path, so a PATH entry cannot stand in for it. */
function powershell() {
  const root = process.env.SystemRoot
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

export const windows = {
  plan(notice, { answerMs }) {
    const asks = wantsAnswer(notice)
    const request = {
      xml: toastXml(notice),
      tag: notice.id === undefined ? '' : tagFor(notice.id),
      waitMs: asks ? answerMs + SLACK_MS : 0,
    }
    return {
      command: powershell(),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      input: Buffer.from(JSON.stringify(request), 'utf8').toString('base64'),
      asks,
      // The toast belongs to Windows once shown: it stays after this helper is gone.
      stays: false,
    }
  },
  read(line) {
    if (line.shown === true) return { type: 'shown' }
    if (typeof line.failed === 'string') return { type: 'failed', reason: line.failed }
    if (typeof line.action === 'string') {
      const text = typeof line.text === 'string' ? Buffer.from(line.text, 'base64').toString('utf8') : ''
      return { type: 'action', action: line.action, text }
    }
    return undefined
  },
}
