# Temporarily distributed unsigned. Use only a trusted CRM download.
$ErrorActionPreference = "Stop"
Write-Warning "This installer is unsigned. Continue only with files from your trusted CRM."
$installDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$executable = Join-Path $installDirectory "TallyConnector.exe"
$configuration = Join-Path $installDirectory "config.json"
$launcher = Join-Path $installDirectory "run-hidden.vbs"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Globussoft Tally Connector.lnk"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"

foreach ($required in @($executable, $configuration, $launcher, $wscript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing required file: $required"
  }
}

# Files extracted from a browser-downloaded ZIP inherit Mark-of-the-Web.
# The hidden VBS launcher cannot surface the resulting Windows security prompt,
# so unblock the packaged files while this installer is already running under
# the user's process-scoped ExecutionPolicy bypass.
foreach ($packageFile in @($executable, $configuration, $launcher)) {
  Unblock-File -LiteralPath $packageFile -ErrorAction Stop
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $installDirectory
$shortcut.WindowStyle = 7
$shortcut.Description = "Starts Globussoft Tally Connector hidden at sign-in"
$shortcut.Save()

function Get-InstalledConnectorProcess {
  @(Get-Process -Name "TallyConnector" -ErrorAction SilentlyContinue) |
    Where-Object { $_.Path -and $_.Path.Equals($executable, [StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
}

$running = Get-InstalledConnectorProcess
if (-not $running) {
  $shell.Run('"' + $wscript + '" "' + $launcher + '"', 0, $false) | Out-Null

  # WScript.Run only confirms that the hidden launcher was invoked. Wait for
  # the real process so the installer never prints a false "running" result.
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $running = Get-InstalledConnectorProcess
  } while (-not $running -and (Get-Date) -lt $deadline)

  if (-not $running) {
    throw "TallyConnector.exe did not stay running. Run .\TallyConnector.exe once in this PowerShell window to see the startup error."
  }
}

Write-Host "Globussoft Tally Connector installed in Startup and process verified from $installDirectory"
