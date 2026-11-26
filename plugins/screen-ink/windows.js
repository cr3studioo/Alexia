// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overlay on Windows: one PowerShell hosting a WPF window over every monitor, transparent,
 * on top, and invisible to the mouse. The script is constant; what to draw arrives on stdin.
 *
 * **Coordinates.** Callers speak the space `computer.screenshot` reports, and that is what a
 * PowerShell which is *not* DPI-aware sees. So the screens are measured twice, before and after
 * this process becomes DPI-aware, and every point is mapped from the first to the second. At
 * 100% scaling the two are the same. Line widths and text grow by the same factor.
 */
export const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Alexia -Name Ink -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr context);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr window, int index);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr window, int index, int value);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr window, System.IntPtr after, int x, int y, int width, int height, uint flags);
'@

# The virtual screen, every monitor together: left, top, width, height.
function Read-Screen { foreach ($metric in 76, 77, 78, 79) { [Alexia.Ink]::GetSystemMetrics($metric) } }

$seen = @(Read-Screen)
$aware = $false
try { $aware = [Alexia.Ink]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { $aware = $false }
if (-not $aware) { [void][Alexia.Ink]::SetProcessDPIAware() }
$real = @(Read-Screen)
$scaleX = $real[2] / $seen[2]
$scaleY = $real[3] / $seen[3]

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# A caller's point, as a point on this window's canvas.
function Convert-X($x) { ($x - $seen[0]) * $scaleX }
function Convert-Y($y) { ($y - $seen[1]) * $scaleY }

function New-Brush($hex) {
  $brush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
  $brush.Freeze()
  $brush
}

function Set-Place($element, $x, $y) {
  [System.Windows.Controls.Canvas]::SetLeft($element, $x)
  [System.Windows.Controls.Canvas]::SetTop($element, $y)
}

function New-Label($text, $fill, $ink) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.Text = [string]$text
  $block.Foreground = New-Brush $ink
  $block.FontFamily = New-Object System.Windows.Media.FontFamily 'Segoe UI'
  $block.FontSize = 15 * $scaleX
  $block.FontWeight = [System.Windows.FontWeights]::SemiBold
  $border = New-Object System.Windows.Controls.Border
  $border.Background = New-Brush $fill
  $border.CornerRadius = New-Object System.Windows.CornerRadius (5 * $scaleX)
  $border.Padding = New-Object System.Windows.Thickness (7 * $scaleX), (2 * $scaleY), (7 * $scaleX), (3 * $scaleY)
  $border.Child = $block
  $border
}

function Add-Shape($layer, $shape) {
  $x = Convert-X $shape.x
  $y = Convert-Y $shape.y
  $labelX = $x
  $labelY = $y
  if ($shape.kind -eq 'box') {
    $box = New-Object System.Windows.Shapes.Rectangle
    $box.Width = $shape.w * $scaleX
    $box.Height = $shape.h * $scaleY
    $box.Stroke = New-Brush $shape.color
    $box.StrokeThickness = 4 * $scaleX
    $box.RadiusX = 6 * $scaleX
    $box.RadiusY = 6 * $scaleY
    Set-Place $box $x $y
    [void]$layer.Children.Add($box)
    # Above the box, or inside its top edge when there is no room above.
    $labelY = $y - 28 * $scaleY
    if ($labelY -lt 0) { $labelY = $y + 6 * $scaleY; $labelX = $x + 6 * $scaleX }
  } elseif ($shape.kind -eq 'arrow') {
    $tipX = Convert-X $shape.to.x
    $tipY = Convert-Y $shape.to.y
    $angle = [Math]::Atan2($tipY - $y, $tipX - $x)
    $long = [Math]::Sqrt(($tipX - $x) * ($tipX - $x) + ($tipY - $y) * ($tipY - $y))
    $head = [Math]::Min(18 * $scaleX, $long)
    $baseX = $tipX - $head * [Math]::Cos($angle)
    $baseY = $tipY - $head * [Math]::Sin($angle)
    $line = New-Object System.Windows.Shapes.Line
    $line.X1 = $x
    $line.Y1 = $y
    $line.X2 = $baseX
    $line.Y2 = $baseY
    $line.Stroke = New-Brush $shape.color
    $line.StrokeThickness = 5 * $scaleX
    [void]$layer.Children.Add($line)
    $wideX = $head * 0.6 * [Math]::Sin($angle)
    $wideY = $head * 0.6 * [Math]::Cos($angle)
    $point = New-Object System.Windows.Shapes.Polygon
    $corners = New-Object System.Windows.Media.PointCollection
    $corners.Add((New-Object System.Windows.Point $tipX, $tipY))
    $corners.Add((New-Object System.Windows.Point ($baseX + $wideX), ($baseY - $wideY)))
    $corners.Add((New-Object System.Windows.Point ($baseX - $wideX), ($baseY + $wideY)))
    $point.Points = $corners
    $point.Fill = New-Brush $shape.color
    [void]$layer.Children.Add($point)
  } elseif ($shape.kind -eq 'dot') {
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = $shape.w * $scaleX
    $dot.Height = $shape.w * $scaleY
    $dot.Fill = New-Brush $shape.color
    Set-Place $dot ($x - $dot.Width / 2) ($y - $dot.Height / 2)
    [void]$layer.Children.Add($dot)
    $labelX = $x + $dot.Width / 2 + 6 * $scaleX
    $labelY = $y - 12 * $scaleY
  }
  if ($shape.text) {
    $label = New-Label $shape.text $shape.color $shape.on
    Set-Place $label $labelX $labelY
    [void]$layer.Children.Add($label)
  }
}

$window = New-Object System.Windows.Window
$window.Title = 'Alexia ink'
$window.WindowStyle = 'None'
$window.ResizeMode = 'NoResize'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.Focusable = $false
$window.IsHitTestVisible = $false

$root = New-Object System.Windows.Controls.Canvas
$shapes = New-Object System.Windows.Controls.Canvas
$pointer = New-Object System.Windows.Controls.Canvas
$pointer.Visibility = 'Hidden'
[void]$root.Children.Add($shapes)
[void]$root.Children.Add($pointer)
$window.Content = $root

# Her cursor: a dot with a white rim, and her name beside it. The canvas's origin is the point.
$rim = New-Object System.Windows.Shapes.Ellipse
$rim.Width = 20 * $scaleX
$rim.Height = 20 * $scaleY
$rim.Fill = New-Brush '#7C5CFF'
$rim.Stroke = New-Brush '#FFFFFF'
$rim.StrokeThickness = 3 * $scaleX
Set-Place $rim (-10 * $scaleX) (-10 * $scaleY)
[void]$pointer.Children.Add($rim)
$name = New-Label 'Alexia' '#7C5CFF' '#FFFFFF'
Set-Place $name (12 * $scaleX) (8 * $scaleY)
[void]$pointer.Children.Add($name)

# TRANSPARENT (0x20) and LAYERED (0x80000) let every click through; TOOLWINDOW (0x80) keeps it
# out of Alt+Tab; NOACTIVATE (0x08000000) keeps it from ever taking focus.
$handle = (New-Object System.Windows.Interop.WindowInteropHelper $window).EnsureHandle()
$style = [Alexia.Ink]::GetWindowLong($handle, -20)
[void][Alexia.Ink]::SetWindowLong($handle, -20, ($style -bor 0x080800A0))

# Topmost again (something else may have gone on top since), without activating, and shown.
function Show-OnTop { [void][Alexia.Ink]::SetWindowPos($handle, [IntPtr](-1), $real[0], $real[1], $real[2], $real[3], 0x0050) }

$window.Show()
Show-OnTop
# The canvas counts in real pixels, whatever size WPF thinks a unit is.
$device = [System.Windows.PresentationSource]::FromVisual($window).CompositionTarget.TransformToDevice
$root.RenderTransform = New-Object System.Windows.Media.ScaleTransform (1 / $device.M11), (1 / $device.M22)

$expiries = New-Object System.Collections.ArrayList

function Remove-Batch($timer) {
  $timer.Stop()
  $shapes.Children.Remove($timer.Tag)
  $expiries.Remove($timer)
}

$script:path = @()
$script:stepMs = 15
$watch = New-Object System.Diagnostics.Stopwatch

function Set-Pointer {
  $at = [Math]::Min($script:path.Count - 1, [int][Math]::Floor($watch.Elapsed.TotalMilliseconds / $script:stepMs))
  $spot = $script:path[$at]
  Set-Place $pointer (Convert-X $spot[0]) (Convert-Y $spot[1])
  if ($at -ge $script:path.Count - 1) { $glide.Stop() }
}

$glide = New-Object System.Windows.Threading.DispatcherTimer ([System.Windows.Threading.DispatcherPriority]::Render)
$glide.Interval = [TimeSpan]::FromMilliseconds(5)
$glide.add_Tick({ Set-Pointer })

$hide = New-Object System.Windows.Threading.DispatcherTimer
$hide.add_Tick({ $hide.Stop(); $pointer.Visibility = 'Hidden' })

function Invoke-Ink($command) {
  if ($command.cmd -eq 'draw') {
    $layer = New-Object System.Windows.Controls.Canvas
    foreach ($shape in $command.shapes) { Add-Shape $layer $shape }
    # However often it is asked, only the newest hundred drawings stay.
    while ($expiries.Count -ge 100) { Remove-Batch $expiries[0] }
    [void]$shapes.Children.Add($layer)
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds($command.ttl_ms)
    $timer.Tag = $layer
    $timer.add_Tick({ param($source) Remove-Batch $source })
    [void]$expiries.Add($timer)
    $timer.Start()
    Show-OnTop
  } elseif ($command.cmd -eq 'clear') {
    while ($expiries.Count -gt 0) { Remove-Batch $expiries[0] }
    $glide.Stop()
    $hide.Stop()
    $pointer.Visibility = 'Hidden'
  } elseif ($command.cmd -eq 'cursor') {
    $name.Child.Text = [string]$command.label
    $script:path = @($command.path)
    $script:stepMs = $command.step_ms
    $watch.Restart()
    Set-Pointer
    $pointer.Visibility = 'Visible'
    if ($script:path.Count -gt 1) { $glide.Start() }
    $hide.Stop()
    $hide.Interval = [TimeSpan]::FromMilliseconds($command.hide_ms)
    $hide.Start()
    Show-OnTop
  } else {
    throw (New-Object System.NotSupportedException)
  }
}

function Write-Answer($answer) {
  [Console]::Out.WriteLine((ConvertTo-Json $answer -Compress))
  [Console]::Out.Flush()
}

function Stop-Overlay { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() }

# Read without blocking the window: the next line is awaited on another thread and looked at here.
$reader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), ([System.Text.Encoding]::UTF8)
$script:pending = $reader.ReadLineAsync()
$poll = New-Object System.Windows.Threading.DispatcherTimer
$poll.Interval = [TimeSpan]::FromMilliseconds(15)
$poll.add_Tick({
  while ($script:pending.IsCompleted) {
    if ($script:pending.IsFaulted -or $null -eq $script:pending.Result) { $poll.Stop(); Stop-Overlay; return }
    $line = $script:pending.Result
    $id = $null
    try {
      $command = ConvertFrom-Json $line
      if ($command.cmd -eq 'quit') { $poll.Stop(); Stop-Overlay; return }
      $id = $command.id
      Invoke-Ink $command
      Write-Answer @{ id = $id; ok = $true }
    } catch {
      # The kind of error only: its message can quote what was being drawn.
      Write-Answer @{ id = $id; ok = $false; error = $_.Exception.GetType().Name }
    }
    $script:pending = $reader.ReadLineAsync()
  }
})
$poll.Start()

Write-Answer @{ ready = $true; window = $handle.ToInt64(); seen = $seen; real = $real }
[System.Windows.Threading.Dispatcher]::Run()
[Environment]::Exit(0)
`

function powershell() {
  const root = process.env.SystemRoot
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

/** `-STA` because WPF needs it; `-InputFormat None` so PowerShell leaves stdin to the script. */
export const windows = () => ({
  command: powershell(),
  args: ['-NoProfile', '-NonInteractive', '-STA', '-InputFormat', 'None', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
})
