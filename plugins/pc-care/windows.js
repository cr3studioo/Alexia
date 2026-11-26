// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path'
import { runProgram } from './run.js'

/**
 * Windows, through PowerShell, with no native module.
 *
 * Every script is constant. The question arrives as JSON on standard input and the answer leaves
 * as UTF-8 JSON; `{refused: "a sentence"}` means nothing could be done, and why.
 */

/** Windows' own programs, by absolute path where Windows says where it is. */
function system32(...parts) {
  const root = process.env.SystemRoot
  return root ? join(root, 'System32', ...parts) : parts.at(-1)
}
export const shell = () => system32('WindowsPowerShell', 'v1.0', 'powershell.exe')
export const shutdownExe = () => system32('shutdown.exe')
export const rundll = () => system32('rundll32.exe')

/** Under the hub's two-minute limit on one call. */
export const UPDATES_MS = 110_000

/**
 * The environment PowerShell is given: this process's, plus the folders Windows' own parts expect
 * and a plugin's short environment leaves out. Without `ProgramData`, asking Windows Update
 * writes a folder literally named `%ProgramData%` wherever it was started.
 */
export function environment(given = process.env) {
  const has = new Set(Object.keys(given).map((name) => name.toUpperCase()))
  const drive = given.SystemDrive || given.SYSTEMDRIVE || 'C:'
  const expected = {
    ProgramData: `${drive}\\ProgramData`,
    ALLUSERSPROFILE: `${drive}\\ProgramData`,
    windir: given.SystemRoot || given.SYSTEMROOT || `${drive}\\Windows`,
  }
  const missing = Object.entries(expected).filter(([name]) => !has.has(name.toUpperCase()))
  return { ...given, ...Object.fromEntries(missing) }
}

const HEAD = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$buffer = New-Object System.IO.MemoryStream
[System.Console]::OpenStandardInput().CopyTo($buffer)
$ask = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
`

const TAIL = `
$bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $answer -Depth 5 -Compress))
$stdout = [System.Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
`

const script = (body) => `${HEAD}${body}${TAIL}`

/**
 * Volume and mute of the default output, through Core Audio. The interface methods are declared
 * in the order COM lays them out; the ones before those used only hold their places. C# 5,
 * because that is what Windows PowerShell compiles.
 */
const CORE_AUDIO = `
using System;
using System.Runtime.InteropServices;
namespace Alexia {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    void RegisterControlChangeNotify(IntPtr client);
    void UnregisterControlChangeNotify(IntPtr client);
    void GetChannelCount(out uint count);
    void SetMasterVolumeLevel(float decibels, IntPtr context);
    void SetMasterVolumeLevelScalar(float level, IntPtr context);
    void GetMasterVolumeLevel(out float decibels);
    void GetMasterVolumeLevelScalar(out float level);
    void SetChannelVolumeLevel(uint channel, float decibels, IntPtr context);
    void SetChannelVolumeLevelScalar(uint channel, float level, IntPtr context);
    void GetChannelVolumeLevel(uint channel, out float decibels);
    void GetChannelVolumeLevelScalar(uint channel, out float level);
    void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
    void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    void Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object found);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int flow, int state, out IntPtr devices);
    void GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }
  public static class Audio {
    static IAudioEndpointVolume Output() {
      IMMDeviceEnumerator devices = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice device;
      devices.GetDefaultAudioEndpoint(0, 1, out device);
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object found;
      device.Activate(ref iid, 23, IntPtr.Zero, out found);
      return (IAudioEndpointVolume)found;
    }
    public static float Volume() { float level; Output().GetMasterVolumeLevelScalar(out level); return level; }
    public static void SetVolume(float level) { Output().SetMasterVolumeLevelScalar(level, IntPtr.Zero); }
    public static bool Muted() { bool mute; Output().GetMute(out mute); return mute; }
    public static void SetMute(bool mute) { Output().SetMute(mute, IntPtr.Zero); }
  }
}
`

export const AUDIO = script(`
Add-Type -TypeDefinition @'
${CORE_AUDIO.trim()}
'@
try {
  if ($ask.do -eq 'volume_set') { [Alexia.Audio]::SetVolume([float]($ask.value / 100)) }
  if ($ask.do -eq 'mute_set') { [Alexia.Audio]::SetMute([bool]$ask.value) }
  $answer = @{ volume = [int][Math]::Round([Alexia.Audio]::Volume() * 100); mute = [bool][Alexia.Audio]::Muted() }
} catch {
  $answer = @{ refused = 'I could not reach a sound output on this computer.' }
}
`)

export const BRIGHTNESS = script(`
try {
  $screens = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods)
  if ($screens.Count -eq 0) { throw 'none' }
  if ($ask.do -eq 'brightness_set') {
    foreach ($screen in $screens) {
      Invoke-CimMethod -InputObject $screen -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]$ask.value } | Out-Null
    }
    Start-Sleep -Milliseconds 300
  }
  $now = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness)
  $answer = @{ brightness = [int]$now[0].CurrentBrightness }
} catch {
  $answer = @{ refused = 'This screen does not let the computer change its brightness. That is usual for a desktop monitor: use its own buttons.' }
}
`)

export const THEME = script(`
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
if ($ask.do -eq 'dark_set') {
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  foreach ($name in 'AppsUseLightTheme', 'SystemUsesLightTheme') {
    New-ItemProperty -LiteralPath $key -Name $name -PropertyType DWord -Value ([int]$ask.light) -Force | Out-Null
  }
  # Tell open windows, or they keep the old colours until they are restarted.
  $signature = '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);'
  $user32 = Add-Type -MemberDefinition $signature -Name Theme -Namespace Alexia -PassThru
  $result = [IntPtr]::Zero
  [void]$user32::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, 'ImmersiveColorSet', 2, 1000, [ref]$result)
}
$found = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
$answer = @{ light = $found.AppsUseLightTheme }
`)

/**
 * Startup items live in three registry keys and two folders. Switching one off writes what Task
 * Manager writes under \`StartupApproved\` (first byte 3, then when), so the item itself stays
 * where it is and can be switched on again there.
 */
export const CARE = script(`
$current = 'Software\\Microsoft\\Windows\\CurrentVersion'
$approved = "$current\\Explorer\\StartupApproved"
$user = [Microsoft.Win32.Registry]::CurrentUser
$machine = [Microsoft.Win32.Registry]::LocalMachine
$places = @(
  @{ where = 'this user'; hive = $user; run = "$current\\Run"; approval = "$approved\\Run" }
  @{ where = 'all users'; hive = $machine; run = "$current\\Run"; approval = "$approved\\Run" }
  @{ where = 'all users, 32-bit'; hive = $machine; run = 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; approval = "$approved\\Run32" }
  @{ where = 'this user, Startup folder'; hive = $user; folder = [Environment]::GetFolderPath('Startup'); approval = "$approved\\StartupFolder" }
  @{ where = 'all users, Startup folder'; hive = $machine; folder = [Environment]::GetFolderPath('CommonStartup'); approval = "$approved\\StartupFolder" }
)

function Get-Entries($place) {
  if ($place.run) {
    $key = $place.hive.OpenSubKey($place.run)
    if ($null -eq $key) { return }
    foreach ($name in $key.GetValueNames()) {
      if ($name -ne '') { @{ name = $name; command = [string]$key.GetValue($name) } }
    }
    $key.Close()
  } elseif ($place.folder -and (Test-Path -LiteralPath $place.folder)) {
    foreach ($file in Get-ChildItem -LiteralPath $place.folder -File) {
      if ($file.Name -ne 'desktop.ini') { @{ name = $file.Name; command = $file.FullName } }
    }
  }
}

# No value, or an even first byte, is on.
function Test-On($place, $name) {
  $key = $place.hive.OpenSubKey($place.approval)
  if ($null -eq $key) { return $true }
  $value = $key.GetValue($name)
  $key.Close()
  if ($value -isnot [byte[]] -or $value.Length -eq 0) { return $true }
  return (($value[0] % 2) -eq 0)
}

function Get-Disks {
  @{ disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    @{ name = [string]$_.DeviceID; label = [string]$_.VolumeName; size = [double]$_.Size; free = [double]$_.FreeSpace }
  }) }
}

function Get-Startup {
  @{ items = @(foreach ($place in $places) {
    foreach ($entry in @(Get-Entries $place)) {
      @{ name = $entry.name; command = $entry.command; where = $place.where; enabled = [bool](Test-On $place $entry.name) }
    }
  }) }
}

function Disable-Startup {
  $place = $places | Where-Object { $_.where -eq $ask.where } | Select-Object -First 1
  if ($null -eq $place -or @(Get-Entries $place | Where-Object { $_.name -eq $ask.name }).Count -eq 0) {
    return @{ refused = 'That startup item is not there any more.' }
  }
  $value = New-Object byte[] 12
  $value[0] = 3
  [System.BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc()).CopyTo($value, 4)
  try {
    $key = $place.hive.CreateSubKey($place.approval)
    $key.SetValue([string]$ask.name, $value, [Microsoft.Win32.RegistryValueKind]::Binary)
    $key.Close()
  } catch [System.UnauthorizedAccessException], [System.Security.SecurityException] {
    return @{ refused = 'That one starts for everyone on this computer, so Windows needs an administrator to switch it off. Task Manager, Startup apps, can do it.' }
  }
  @{ disabled = (-not (Test-On $place $ask.name)) }
}

# Looking is all this does: nothing is downloaded or installed.
function Get-Updates {
  try {
    $searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
    $found = $searcher.Search('IsInstalled=0 and IsHidden=0')
    @{ updates = @(foreach ($update in $found.Updates) { [string]$update.Title }) }
  } catch {
    @{ refused = 'Windows Update did not answer. Check Settings, Windows Update.' }
  }
}

$answer = switch ($ask.do) {
  'disk' { Get-Disks }
  'startup' { Get-Startup }
  'startup_disable' { Disable-Startup }
  'updates' { Get-Updates }
  default { @{ refused = 'That is not a check I know.' } }
}
`)

/**
 * Delete the files nothing has open. Opening one while sharing it with nobody fails when anybody
 * else holds it, and "delete on close" then removes exactly the file that was just proved free.
 * Answers with the positions of the files it deleted.
 */
export const DELETE = script(`
$files = @($ask.files)
$deleted = @(for ($i = 0; $i -lt $files.Count; $i++) {
  try {
    $item = New-Object System.IO.FileInfo([string]$files[$i])
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $stream = New-Object System.IO.FileStream($item.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
    $stream.Dispose()
    $i
  } catch { }
})
$answer = @{ deleted = $deleted }
`)

export const SLEEP = script(`
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)) {
  $answer = @{ ok = $true }
} else {
  $answer = @{ refused = 'Windows would not go to sleep.' }
}
`)

/** The antivirus and a blocked script, said as sentences. */
export function explain(complaint) {
  if (/ScriptContainedMaliciousContent/.test(complaint)) {
    return (
      'Windows blocked this script before it ran, because the antivirus decided it looked like malware. ' +
      'Nothing was done. Allowing Alexia in your antivirus settings is the only thing that changes it.'
    )
  }
  return complaint.split('\n')[0]?.trim()
}

const FOCUS =
  'Windows does not let a program turn Focus assist (Do not disturb) on or off, or read it. ' +
  'You can switch it in the notification panel (Windows key + N).'

export function windowsBackend({ run = runProgram } = {}) {
  async function ask(text, question, { signal, timeout } = {}) {
    const { stdout } = await run(shell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', text], {
      input: JSON.stringify(question),
      env: environment(),
      signal,
      timeout,
      explain,
    })
    let answer
    try {
      answer = JSON.parse(stdout)
    } catch {
      throw new Error('The Windows helper answered with something unreadable.')
    }
    if (typeof answer?.refused === 'string') throw new Error(answer.refused)
    return answer
  }

  /** One setting: the script, the question that reads or writes it, and how its answer reads. */
  async function setting(what, value, signal) {
    const writing = value !== undefined
    if (what === 'volume' || what === 'mute') {
      const question = writing ? { do: `${what}_set`, value } : { do: 'audio' }
      const answer = await ask(AUDIO, question, { signal })
      return what === 'volume' ? Number(answer.volume) : answer.mute === true
    }
    if (what === 'brightness') {
      const question = writing ? { do: 'brightness_set', value } : { do: 'brightness' }
      return Number((await ask(BRIGHTNESS, question, { signal })).brightness)
    }
    if (what === 'dark_mode') {
      // The registry says "uses the light theme": 0 is dark. Never set, it is light.
      const question = writing ? { do: 'dark_set', light: value ? 0 : 1 } : { do: 'dark' }
      return (await ask(THEME, question, { signal })).light === 0
    }
    throw new Error(FOCUS)
  }

  const program = (file, args, signal) => run(file, args, { signal })

  const POWER = {
    lock: (signal) => program(rundll(), ['user32.dll,LockWorkStation'], signal),
    sleep: (signal) => ask(SLEEP, { do: 'sleep' }, { signal }),
    // No /f and no wait: an app with unsaved work can still stop it and ask.
    restart: (signal) => program(shutdownExe(), ['/r', '/t', '0'], signal),
    shutdown: (signal) => program(shutdownExe(), ['/s', '/t', '0'], signal),
  }

  return {
    get: (what, signal) => setting(what, undefined, signal),
    set: (what, value, signal) => setting(what, value, signal),
    disks: async (signal) => [(await ask(CARE, { do: 'disk' }, { signal })).disks ?? []].flat(),
    startup: async (signal) => ({
      items: [(await ask(CARE, { do: 'startup' }, { signal })).items ?? []].flat(),
      notes: [],
    }),
    async disableStartup({ name, where }, signal) {
      const answer = await ask(CARE, { do: 'startup_disable', name, where }, { signal })
      if (answer.disabled !== true) throw new Error(`Windows did not switch ${name} off.`)
      return `${name} will no longer start with Windows. Task Manager, Startup apps, can switch it on again.`
    },
    updates: async (signal) => [(await ask(CARE, { do: 'updates' }, { signal, timeout: UPDATES_MS })).updates ?? []].flat(),
    async deleteUnused(files, signal) {
      const answer = await ask(DELETE, { do: 'delete', files: files.map((one) => one.path) }, { signal })
      return [answer.deleted ?? []].flat().map((index) => files[index]).filter(Boolean)
    },
    power: async (action, signal) => void (await POWER[action](signal)),
  }
}
