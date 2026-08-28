# The human half of M2-S1, driven without a human: launch the spike, press Ctrl+Alt+Space at
# the OS, and ask Win32 what happened.
#
# Windows are found by enumerating the process's own, not by FindWindow — PowerShell coerces
# a $null class name to "", which matches nothing and looks exactly like "no window".
Add-Type -Namespace W -Name N -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetWindowLongPtr(System.IntPtr h, int i);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int pid);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.IntPtr extra);
'@

$exe = "C:\Users\vacla\orca\Alexia\spikes\tauri-overlay\target\debug\alexia-overlay-spike.exe"
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 7

function Get-SpikeWindows {
  $script:rows = @()
  $cb = [W.N+EnumProc] {
    param($h, $p)
    $owner = 0
    [void][W.N]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $app.Id) {
      $t = New-Object System.Text.StringBuilder 512
      [void][W.N]::GetWindowTextW($h, $t, 512)
      $c = New-Object System.Text.StringBuilder 512
      [void][W.N]::GetClassNameW($h, $c, 512)
      $script:rows += [pscustomobject]@{
        Handle  = $h
        Title   = $t.ToString()
        Class   = $c.ToString()
        Visible = [W.N]::IsWindowVisible($h)
        Topmost = (([int64][W.N]::GetWindowLongPtr($h, -20)) -band 0x8) -ne 0
      }
    }
    return $true
  }
  [void][W.N]::EnumWindows($cb, [IntPtr]::Zero)
  $script:rows
}

$all = Get-SpikeWindows
$overlay = $all | Where-Object { $_.Title -eq "Alexia overlay spike" } | Select-Object -First 1
if (-not $overlay) { "FAIL: no overlay window"; $app.Kill(); exit 1 }

# The tray and the shortcut each own a message-only window. Their presence is the registration.
"tray registered      : $([bool]($all | Where-Object { $_.Class -eq 'tray_icon_app' }))"
"hotkey registered    : $([bool]($all | Where-Object { $_.Class -eq 'global_hotkey_app' }))"
"visible before hotkey: $($overlay.Visible)   expected False"
"topmost before hotkey: $($overlay.Topmost)   expected True"

$caller = [W.N]::GetForegroundWindow()
# Ctrl+Alt+Space at the keyboard, not at a window. SendKeys is the wrong altitude: a shortcut
# taken with RegisterHotKey listens to the input stream, not to a window's message queue.
[W.N]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)   # Ctrl down
[W.N]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)   # Alt down
[W.N]::keybd_event(0x20, 0, 0, [IntPtr]::Zero)   # Space down
Start-Sleep -Milliseconds 60
[W.N]::keybd_event(0x20, 0, 2, [IntPtr]::Zero)   # Space up
[W.N]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)   # Alt up
[W.N]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)   # Ctrl up
Start-Sleep -Milliseconds 900

$after = (Get-SpikeWindows | Where-Object { $_.Handle -eq $overlay.Handle })
"visible after hotkey : $($after.Visible)   expected True"
"topmost after hotkey : $($after.Topmost)   expected True"

# Take the focus away and let the blur handler do the rest. Nothing here hides the window.
[void][W.N]::SetForegroundWindow($caller)
Start-Sleep -Milliseconds 900
$blurred = (Get-SpikeWindows | Where-Object { $_.Handle -eq $overlay.Handle })
"visible after blur   : $($blurred.Visible)   expected False"

$app.Kill()
"stopped"
