param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Thumbprint,

  [string]$TimestampServer
)

$ErrorActionPreference = "Stop"
$normalizedThumbprint = ($Thumbprint -replace "\s", "").ToUpperInvariant()
if ($normalizedThumbprint -notmatch "^[0-9A-F]{40}$") {
  throw "Provide the 40-character SHA-1 thumbprint of your code-signing certificate."
}

$certificate = @(
  Get-ChildItem -Path Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert |
    Where-Object { $_.Thumbprint -eq $normalizedThumbprint -and $_.HasPrivateKey }
) | Select-Object -First 1
if (-not $certificate) {
  throw "No accessible code-signing certificate with this thumbprint and a private key was found."
}

$connectorDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($name in @("install-startup.ps1", "uninstall-startup.ps1")) {
  $scriptPath = Join-Path $connectorDirectory $name
  $content = [System.IO.File]::ReadAllText($scriptPath)
  $signatureMarker = "# SIG # Begin signature block"
  $signatureIndex = $content.IndexOf($signatureMarker, [StringComparison]::Ordinal)
  if ($signatureIndex -ge 0) {
    $content = $content.Substring(0, $signatureIndex).TrimEnd([char[]]@("`r", "`n")) + "`r`n"
    [System.IO.File]::WriteAllText($scriptPath, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Removed the previous signature block from $name"
  }

  $options = @{
    LiteralPath = $scriptPath
    Certificate = $certificate
    HashAlgorithm = "SHA256"
    Force = $true
  }
  if ($TimestampServer) {
    $options.TimestampServer = $TimestampServer
  }

  $result = Set-AuthenticodeSignature @options
  if ($result.Status -ne "Valid") {
    throw "Signing ${name} failed: $($result.Status) $($result.StatusMessage)"
  }

  $verified = Get-AuthenticodeSignature -LiteralPath $scriptPath
  if ($verified.Status -ne "Valid" -or $verified.SignerCertificate.Thumbprint -ne $normalizedThumbprint) {
    throw "Signature verification failed for ${name}: $($verified.Status) $($verified.StatusMessage)"
  }
  Write-Host "Signed and verified $name"
}
