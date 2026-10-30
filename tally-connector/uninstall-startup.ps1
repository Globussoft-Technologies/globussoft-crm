# Temporarily distributed unsigned. Use only a trusted CRM download.
$ErrorActionPreference = "Stop"
Write-Warning "This uninstaller is unsigned. Continue only with files from your trusted CRM."
$installDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$executable = Join-Path $installDirectory "TallyConnector.exe"
$launcher = Join-Path $installDirectory "run-hidden.vbs"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Globussoft Tally Connector.lnk"

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
  if ($shortcut.Arguments -eq ('"' + $launcher + '"')) {
    Remove-Item -LiteralPath $shortcutPath -Force
  }
}

Get-CimInstance Win32_Process -Filter "Name = 'TallyConnector.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($executable, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Globussoft Tally Connector removed from Startup and stopped"
