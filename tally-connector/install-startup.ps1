param(
  [string]$InstallDirectory = "$env:ProgramData\Globussoft\TallyConnector"
)

$ErrorActionPreference = "Stop"
$sourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$executable = Join-Path $sourceDirectory "globussoft-tally-connector.exe"
$configuration = Join-Path $sourceDirectory "config.json"

if (-not (Test-Path -LiteralPath $executable)) { throw "Missing $executable" }
if (-not (Test-Path -LiteralPath $configuration)) { throw "Missing $configuration" }

New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $InstallDirectory "globussoft-tally-connector.exe") -Force
Copy-Item -LiteralPath $configuration -Destination (Join-Path $InstallDirectory "config.json") -Force

$installedExecutable = Join-Path $InstallDirectory "globussoft-tally-connector.exe"
$action = New-ScheduledTaskAction -Execute $installedExecutable -WorkingDirectory $InstallDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "Globussoft Tally Connector" -Action $action -Trigger $trigger -Settings $settings -Description "Connects local Tally to Globussoft CRM" -Force | Out-Null
Start-ScheduledTask -TaskName "Globussoft Tally Connector"
Write-Host "Globussoft Tally Connector installed and started from $InstallDirectory"
