param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = 'Stop'
$required = @(
  'AZURE_ARTIFACT_SIGNING_ENDPOINT',
  'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  'AZURE_ARTIFACT_SIGNING_PROFILE',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID'
)

foreach ($name in $required) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    throw "Missing required release signing variable: $name"
  }
}

& artifact-signing-cli sign `
  -e $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
  -a $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
  -c $env:AZURE_ARTIFACT_SIGNING_PROFILE `
  -d 'Balto Harness' `
  $File

if ($LASTEXITCODE -ne 0) { throw "Windows signing failed for $File" }
