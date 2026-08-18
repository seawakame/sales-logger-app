# =====================================================================
#  make-icons.ps1 - Generates PWA icons (PNG) with .NET System.Drawing.
#  Usage:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#  Output: public\icons\*.png
# =====================================================================
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\public\icons"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function New-AppIcon {
  param(
    [int]$Size,
    [string]$FileName,
    [double]$PinScale = 1.0,   # 1.0 = normal, 0.72 = maskable safe zone
    [bool]$Rounded = $true
  )

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # ---- background (indigo -> violet gradient) ----
  $rect  = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $c1    = [System.Drawing.Color]::FromArgb(79, 70, 229)
  $c2    = [System.Drawing.Color]::FromArgb(124, 58, 237)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)

  if ($Rounded) {
    $r = [int]($Size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r*2, $r*2, 180, 90)
    $path.AddArc($Size-$r*2, 0, $r*2, $r*2, 270, 90)
    $path.AddArc($Size-$r*2, $Size-$r*2, $r*2, $r*2, 0, 90)
    $path.AddArc(0, $Size-$r*2, $r*2, $r*2, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)
    $path.Dispose()
  } else {
    $g.FillRectangle($brush, $rect)
  }

  # ---- map pin (white) ----
  $cx = $Size / 2.0
  $r  = $Size * 0.20 * $PinScale
  $cy = $Size / 2.0 - $r * 0.42

  $pin = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pin.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding
  $pin.AddEllipse([single]($cx - $r), [single]($cy - $r), [single]($r * 2), [single]($r * 2))

  $pts = New-Object 'System.Drawing.PointF[]' 3
  $pts[0] = New-Object System.Drawing.PointF([single]($cx - $r * 0.80), [single]($cy + $r * 0.58))
  $pts[1] = New-Object System.Drawing.PointF([single]($cx + $r * 0.80), [single]($cy + $r * 0.58))
  $pts[2] = New-Object System.Drawing.PointF([single]$cx, [single]($cy + $r * 2.35))
  $pin.AddPolygon($pts)

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillPath($white, $pin)

  # ---- pin hole (background color) ----
  $hole = $r * 0.40
  $holeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(93, 64, 232))
  $g.FillEllipse($holeBrush, [single]($cx - $hole), [single]($cy - $hole), [single]($hole * 2), [single]($hole * 2))

  $path2 = Join-Path $outDir $FileName
  $bmp.Save($path2, [System.Drawing.Imaging.ImageFormat]::Png)

  $brush.Dispose(); $white.Dispose(); $holeBrush.Dispose(); $pin.Dispose(); $g.Dispose(); $bmp.Dispose()
  Write-Output ("created: " + $FileName + "  (" + $Size + "x" + $Size + ")")
}

New-AppIcon -Size 192 -FileName "icon-192.png"           -PinScale 1.0  -Rounded $true
New-AppIcon -Size 512 -FileName "icon-512.png"           -PinScale 1.0  -Rounded $true
New-AppIcon -Size 512 -FileName "icon-maskable-512.png"  -PinScale 0.68 -Rounded $false
New-AppIcon -Size 180 -FileName "apple-touch-icon.png"   -PinScale 1.0  -Rounded $false
Write-Output "done."
