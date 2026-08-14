param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconPath = Join-Path $ProjectRoot 'src-tauri\icons\icon.png'
$outputRoot = Join-Path $ProjectRoot 'src-tauri\icons'
$icon = [System.Drawing.Image]::FromFile($iconPath)

function New-Canvas([int]$Width, [int]$Height) {
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  return @($bitmap, $graphics)
}

$sidebar = New-Canvas 164 314
$sidebarBitmap = $sidebar[0]
$sidebarGraphics = $sidebar[1]
$sidebarBackground = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(0, 0, 164, 314),
  [System.Drawing.ColorTranslator]::FromHtml('#171b20'),
  [System.Drawing.ColorTranslator]::FromHtml('#0d0f12'),
  90
)
$sidebarGraphics.FillRectangle($sidebarBackground, 0, 0, 164, 314)
$sidebarGraphics.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(32, 255, 107, 53)), -45, -48, 220, 190)
$sidebarGraphics.DrawImage($icon, 46, 33, 72, 72)
$sidebarGraphics.DrawString('BALTO', [System.Drawing.Font]::new('Segoe UI Semibold', 23), [System.Drawing.Brushes]::White, 36, 123)
$sidebarGraphics.DrawString('S P E E D R U N N E R', [System.Drawing.Font]::new('Segoe UI Semibold', 6.5), [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#9ba2aa')), 26, 160)
$sidebarGraphics.FillRectangle([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#ff6b35')), 27, 190, 18, 2)
$sidebarGraphics.DrawString('QWEN 3.8 27B', [System.Drawing.Font]::new('Segoe UI Semibold', 9), [System.Drawing.Brushes]::White, 27, 210)
$sidebarGraphics.DrawString('2x the speed', [System.Drawing.Font]::new('Segoe UI Semibold', 12), [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#54df9b')), 27, 231)
$sidebarGraphics.DrawString('Built for RTX 5090', [System.Drawing.Font]::new('Segoe UI', 7), [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#89919a')), 27, 276)
$sidebarPath = Join-Path $outputRoot 'installer-sidebar.bmp'
$sidebarBitmap.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$sidebarBackground.Dispose()
$sidebarGraphics.Dispose()
$sidebarBitmap.Dispose()

$header = New-Canvas 150 57
$headerBitmap = $header[0]
$headerGraphics = $header[1]
$headerGraphics.Clear([System.Drawing.Color]::White)
$headerGraphics.DrawImage($icon, 91, 6, 44, 44)
$headerGraphics.DrawString('BALTO', [System.Drawing.Font]::new('Segoe UI Semibold', 13), [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#15181d')), 9, 10)
$headerGraphics.DrawString('SPEEDRUNNER', [System.Drawing.Font]::new('Segoe UI Semibold', 6.5), [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#ff6b35')), 10, 32)
$headerPath = Join-Path $outputRoot 'installer-header.bmp'
$headerBitmap.Save($headerPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$headerGraphics.Dispose()
$headerBitmap.Dispose()
$icon.Dispose()

Write-Output "Generated $sidebarPath"
Write-Output "Generated $headerPath"
