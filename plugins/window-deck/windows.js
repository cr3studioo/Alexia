// SPDX-License-Identifier: AGPL-3.0-only
import { createBackend, runProgram } from './backend.js'

/**
 * Windows, through PowerShell and user32.
 *
 * No native module: `Add-Type` compiles the few calls needed on every Windows machine. One
 * PowerShell spawn per question, which is slow next to a native call and nothing next to the
 * model call on either side of it.
 *
 * Three things Windows does that this has to undo:
 *
 * - **Scaling.** An unaware process is told made-up coordinates, so it declares itself
 *   per-monitor aware first and everything is in real pixels.
 * - **Invisible borders.** A window's rectangle includes about seven transparent pixels on three
 *   sides. Rows report the frame a person sees (DWM's), and placing adds the border back, so
 *   two snapped windows touch.
 * - **Store apps.** Their window belongs to ApplicationFrameHost; the app is the process of the
 *   CoreWindow inside it.
 */

/** Windows' own PowerShell, by absolute path. */
export function shell() {
  const root = process.env.SystemRoot
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

/** The user32 and dwmapi half, in C# 5 because that is what Windows PowerShell compiles. */
const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace Alexia {
  public static class Deck {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT { public int Length, Flags, ShowCmd; public POINT Min, Max; public RECT Normal; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor, Work; public int Flags; }
    delegate bool WindowProc(IntPtr window, IntPtr data);
    delegate bool MonitorProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")] static extern bool EnumWindows(WindowProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref RECT rect, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int how);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint how);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int most);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int most);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string kind, string title);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref PLACEMENT placement);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmRect(IntPtr window, int attribute, out RECT value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmNumber(IntPtr window, int attribute, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);

    public static void BeDpiAware() {
      try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
      SetProcessDPIAware();
    }

    public static string Title(IntPtr window) {
      StringBuilder text = new StringBuilder(512);
      GetWindowText(window, text, text.Capacity);
      return text.ToString();
    }

    static string Kind(IntPtr window) {
      StringBuilder text = new StringBuilder(256);
      GetClassName(window, text, text.Capacity);
      return text.ToString();
    }

    // What a person would call a window: what the Alt+Tab list shows, minimised ones included.
    static bool Listed(IntPtr window) {
      if (!IsWindowVisible(window)) return false;
      int extra = GetWindowLong(window, -20);
      bool app = (extra & 0x40000) != 0;
      if (!app && ((extra & 0x80) != 0 || GetWindow(window, 4) != IntPtr.Zero)) return false;
      int cloaked = 0;
      if (DwmNumber(window, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
      if (Title(window).Length == 0) return false;
      string kind = Kind(window);
      if (kind == "Progman" || kind == "WorkerW" || kind == "Shell_TrayWnd" || kind == "Shell_SecondaryTrayWnd") return false;
      if (kind == "Windows.UI.Core.CoreWindow") return false;
      RECT r;
      if (!IsIconic(window) && GetWindowRect(window, out r) && (r.Right <= r.Left || r.Bottom <= r.Top)) return false;
      return true;
    }

    public static IntPtr[] Windows() {
      List<IntPtr> found = new List<IntPtr>();
      EnumWindows(delegate(IntPtr window, IntPtr data) { if (Listed(window)) found.Add(window); return true; }, IntPtr.Zero);
      return found.ToArray();
    }

    public static uint Owner(IntPtr window) {
      uint pid;
      if (Kind(window) == "ApplicationFrameWindow") {
        IntPtr core = FindWindowEx(window, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
        // A minimised store app's CoreWindow is detached from its frame and kept at the top.
        if (core == IntPtr.Zero) core = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Windows.UI.Core.CoreWindow", Title(window));
        if (core != IntPtr.Zero) { GetWindowThreadProcessId(core, out pid); return pid; }
      }
      GetWindowThreadProcessId(window, out pid);
      return pid;
    }

    // The id a store app is started by; empty for an ordinary program.
    public static string AppId(uint pid) {
      IntPtr process = OpenProcess(0x1000, false, pid);
      if (process == IntPtr.Zero) return "";
      try {
        uint length = 512;
        StringBuilder id = new StringBuilder(512);
        return GetApplicationUserModelId(process, ref length, id) == 0 ? id.ToString() : "";
      } finally { CloseHandle(process); }
    }

    static int[] Box(RECT r) { return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top }; }

    static RECT Visible(IntPtr window) {
      RECT seen;
      if (DwmRect(window, 9, out seen, 16) == 0 && seen.Right > seen.Left) return seen;
      GetWindowRect(window, out seen);
      return seen;
    }

    // x, y, w, h of what is seen; for a minimised window, of where it will come back to.
    public static int[] Frame(IntPtr window) {
      if (!IsIconic(window)) return Box(Visible(window));
      PLACEMENT place = new PLACEMENT();
      place.Length = Marshal.SizeOf(typeof(PLACEMENT));
      GetWindowPlacement(window, ref place);
      RECT r = place.Normal;
      // Placement counts from the work area's corner, not the screen's.
      MONITORINFO info = new MONITORINFO();
      info.Size = Marshal.SizeOf(typeof(MONITORINFO));
      if (GetMonitorInfo(MonitorFromRect(ref r, 2), ref info)) {
        int dx = info.Work.Left - info.Monitor.Left, dy = info.Work.Top - info.Monitor.Top;
        r.Left += dx; r.Right += dx; r.Top += dy; r.Bottom += dy;
      }
      return Box(r);
    }

    // x, y, w, h, work x, work y, work w, work h, primary.
    public static List<int[]> Monitors() {
      List<int[]> found = new List<int[]>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
        MONITORINFO info = new MONITORINFO();
        info.Size = Marshal.SizeOf(typeof(MONITORINFO));
        if (GetMonitorInfo(monitor, ref info)) {
          int[] m = Box(info.Monitor), w = Box(info.Work);
          found.Add(new int[] { m[0], m[1], m[2], m[3], w[0], w[1], w[2], w[3], info.Flags & 1 });
        }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    // Put the seen frame at x, y, w, h without raising or focusing it. 0, or Windows' error.
    public static int Place(IntPtr window, int x, int y, int w, int h) {
      RECT outer; GetWindowRect(window, out outer);
      RECT seen = Visible(window);
      int left = seen.Left - outer.Left, top = seen.Top - outer.Top;
      int right = outer.Right - seen.Right, bottom = outer.Bottom - seen.Bottom;
      if (SetWindowPos(window, IntPtr.Zero, x - left, y - top, w + left + right, h + top + bottom, 0x0014)) return 0;
      int error = Marshal.GetLastWin32Error();
      return error == 0 ? -1 : error;
    }

    // WM_CLOSE: the same as pressing the X, so the app can still ask about unsaved work.
    public static int Close(IntPtr window) {
      if (PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero)) return 0;
      int error = Marshal.GetLastWin32Error();
      return error == 0 ? -1 : error;
    }
  }
}
`

const POWERSHELL = `
function Get-Row($window) {
  $owner = [Alexia.Deck]::Owner($window)
  $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
  $path = ''
  try { $path = [string]$process.Path } catch { }
  $box = [Alexia.Deck]::Frame($window)
  @{
    id = [string]$window.ToInt64()
    app = [string]$process.ProcessName
    title = [Alexia.Deck]::Title($window)
    x = $box[0]; y = $box[1]; w = $box[2]; h = $box[3]
    minimized = [bool][Alexia.Deck]::IsIconic($window)
    maximized = [bool][Alexia.Deck]::IsZoomed($window)
    path = $path
    aumid = [Alexia.Deck]::AppId($owner)
  }
}

function Get-Refusal($code) {
  if ($code -eq 5) { return 'Windows would not let me: that app is running as administrator.' }
  return "Windows refused (error $code)."
}

function Get-List {
  $rows = @(foreach ($window in [Alexia.Deck]::Windows()) { Get-Row $window })
  $screens = @(foreach ($m in [Alexia.Deck]::Monitors()) {
    @{ x = $m[0]; y = $m[1]; w = $m[2]; h = $m[3]; work = @{ x = $m[4]; y = $m[5]; w = $m[6]; h = $m[7] }; primary = ($m[8] -eq 1) }
  })
  @{ windows = $rows; monitors = $screens }
}

function Invoke-Op($op) {
  $window = [System.IntPtr][long]$op.id
  if (-not [Alexia.Deck]::IsWindow($window)) { return @{ id = $op.id; ok = $false; gone = $true; why = 'That window is gone.' } }
  if ([Alexia.Deck]::IsHungAppWindow($window)) { return @{ id = $op.id; ok = $false; why = 'That window is not responding.' } }
  $why = ''
  $unchanged = $false
  if ($null -ne $op.rect) {
    # Back to an ordinary window first: a maximised or minimised one cannot be placed.
    foreach ($how in 4, 9) {
      if ([Alexia.Deck]::IsIconic($window) -or [Alexia.Deck]::IsZoomed($window)) {
        [void][Alexia.Deck]::ShowWindow($window, $how)
        Start-Sleep -Milliseconds 250
      }
    }
    $box = [Alexia.Deck]::Frame($window)
    $x = $box[0]; $y = $box[1]; $w = $box[2]; $h = $box[3]
    if ($null -ne $op.rect.x) { $x = [int]$op.rect.x }
    if ($null -ne $op.rect.y) { $y = [int]$op.rect.y }
    if ($null -ne $op.rect.w) { $w = [int]$op.rect.w }
    if ($null -ne $op.rect.h) { $h = [int]$op.rect.h }
    # Twice when needed: a window that lands on a screen with another scaling resizes itself.
    foreach ($try in 1, 2) {
      $code = [Alexia.Deck]::Place($window, $x, $y, $w, $h)
      if ($code -ne 0) { $why = Get-Refusal $code; break }
      Start-Sleep -Milliseconds 150
      $now = [Alexia.Deck]::Frame($window)
      if ($now[0] -eq $x -and $now[1] -eq $y -and $now[2] -eq $w -and $now[3] -eq $h) { break }
    }
  }
  if ($why -eq '' -and $op.then) {
    if ($op.then -eq 'minimize') {
      [void][Alexia.Deck]::ShowWindow($window, 7)
      Start-Sleep -Milliseconds 250
      if (-not [Alexia.Deck]::IsIconic($window)) { $why = 'Windows would not minimise it.' }
    } elseif ($op.then -eq 'maximize') {
      [void][Alexia.Deck]::ShowWindow($window, 3)
      Start-Sleep -Milliseconds 250
      if (-not [Alexia.Deck]::IsZoomed($window)) { $why = 'Windows would not maximise it.' }
    } elseif ($op.then -eq 'restore') {
      if ([Alexia.Deck]::IsIconic($window) -or [Alexia.Deck]::IsZoomed($window)) {
        $wasIconic = [Alexia.Deck]::IsIconic($window)
        [void][Alexia.Deck]::ShowWindow($window, 9)
        Start-Sleep -Milliseconds 250
        # A window minimised while maximised comes back maximised, which is restored.
        if ([Alexia.Deck]::IsIconic($window) -or (-not $wasIconic -and [Alexia.Deck]::IsZoomed($window))) { $why = 'Windows would not restore it.' }
      } else {
        $unchanged = $true
      }
    } elseif ($op.then -eq 'close') {
      $code = [Alexia.Deck]::Close($window)
      if ($code -ne 0) {
        $why = Get-Refusal $code
      } else {
        $until = (Get-Date).AddMilliseconds(2000)
        while ([Alexia.Deck]::IsWindowVisible($window) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
      }
    }
  }
  $gone = -not [Alexia.Deck]::IsWindowVisible($window)
  $result = @{ id = $op.id; ok = ($why -eq ''); why = $why; gone = $gone; unchanged = $unchanged }
  if (-not $gone) { $result.window = Get-Row $window }
  return $result
}

function Get-Targets {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $ask.app -and $_.Id -ne $PID -and @($ask.spare) -notcontains $_.Id })
}

function Get-AppWindows {
  @(foreach ($window in [Alexia.Deck]::Windows()) {
    $process = Get-Process -Id ([Alexia.Deck]::Owner($window)) -ErrorAction SilentlyContinue
    if ($process.ProcessName -eq $ask.app -and @($ask.spare) -notcontains $process.Id) { $window }
  })
}

function Invoke-Quit {
  $windows = @(Get-AppWindows)
  $targets = @(Get-Targets)
  $found = $targets.Count
  $until = (Get-Date).AddMilliseconds([int]$ask.waitMs)
  if ($ask.force) {
    foreach ($process in $targets) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    while (@(Get-Targets).Count -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 200 }
  } else {
    foreach ($window in $windows) { [void][Alexia.Deck]::Close($window) }
    while (@(Get-AppWindows).Count -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 200 }
    # Windows gone: give the process a moment to follow them.
    if ($windows.Count -gt 0 -and @(Get-AppWindows).Count -eq 0) {
      $until = (Get-Date).AddMilliseconds(2000)
      while (@(Get-Targets).Count -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 200 }
    }
  }
  @{ found = $found; windows = $windows.Count; open = @(Get-AppWindows).Count; running = @(Get-Targets).Count }
}

function Invoke-Open {
  if ($ask.aumid) {
    Start-Process -FilePath ('shell:AppsFolder\\' + $ask.aumid)
  } elseif ($ask.path -and (Test-Path -LiteralPath $ask.path -PathType Leaf)) {
    Start-Process -FilePath $ask.path
  } else {
    Start-Process -FilePath $ask.app
  }
  @{ opened = $true }
}

$answer = switch ($ask.do) {
  'list' { Get-List }
  'apply' { @{ results = @(foreach ($op in @($ask.ops)) { Invoke-Op $op }) } }
  'quit' { Invoke-Quit }
  'open' { Invoke-Open }
  default { @{ refused = 'That is not something this can do with windows.' } }
}
# Bytes, so a title in any alphabet arrives as UTF-8 whatever the console's code page is.
$bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $answer -Depth 6 -Compress))
$stdout = [System.Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
`

/** The whole script. Constant: the question arrives in `ALEXIA_DECK_ARGS`. */
export const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -TypeDefinition @'",
  CSHARP.trim(),
  "'@",
  '[Alexia.Deck]::BeDpiAware()',
  '$ask = $env:ALEXIA_DECK_ARGS | ConvertFrom-Json',
  // So an app this starts does not inherit the question.
  '$env:ALEXIA_DECK_ARGS = $null',
  POWERSHELL.trim(),
].join('\n')

/** The antivirus and a failed script, said as sentences. */
export function explain(complaint) {
  if (/ScriptContainedMaliciousContent/.test(complaint)) {
    return (
      'Windows blocked this script before it ran — the antivirus decided it looked like malware. ' +
      'Nothing was done. Allowing Alexia in your antivirus settings is the only thing that changes it.'
    )
  }
  return complaint.split('\n')[0]?.trim()
}

/** The real runner: `question` goes to the script in the environment, never into its text. */
export const powershell = (script, question, signal) =>
  runProgram(shell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    signal,
    env: { ...process.env, ALEXIA_DECK_ARGS: JSON.stringify(question) },
    explain,
  })

export const windowsBackend = ({ run = powershell } = {}) => createBackend(run, SCRIPT)
