$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\balto.ps1'
$qaScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\qa-clean-install.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw $parseErrors[0].Message }
$qaTokens = $null
$qaParseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($qaScriptPath, [ref]$qaTokens, [ref]$qaParseErrors)
if ($qaParseErrors.Count -gt 0) { throw $qaParseErrors[0].Message }

foreach ($name in @('Write-Log', 'ConvertTo-NativeArgument', 'Invoke-HiddenNativeCapture', 'Invoke-LoggedNative')) {
  $functionAst = $ast.Find({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
  if (-not $functionAst) { throw "Missing function under test: $name" }
  . ([scriptblock]::Create($functionAst.Extent.Text))
}

$testLog = [System.IO.Path]::GetTempFileName()
$logPath = $testLog
try {
  Invoke-LoggedNative -FilePath 'node.exe' -Arguments @('-e', 'console.error("npm warn deprecated harmless"); process.exit(0)') -Prefix 'warning smoke'
  $captured = Get-Content -LiteralPath $testLog -Raw
  if ($captured -notmatch 'npm warn deprecated harmless') { throw 'Native stderr was not logged.' }

  $failedOnExitCode = $false
  try {
    Invoke-LoggedNative -FilePath 'node.exe' -Arguments @('-e', 'process.exit(9)') -Prefix 'failure smoke'
  }
  catch {
    $failedOnExitCode = $_.Exception.Message -match 'exited with code 9'
  }
  if (-not $failedOnExitCode) { throw 'A nonzero native exit code did not fail.' }
  Write-Output 'Native warning regression test passed.'
}
finally {
  Remove-Item -LiteralPath $testLog -Force -ErrorAction SilentlyContinue
}
