param(
  [switch]$NoBrowser,
  [string]$PackagePath = 'D:\comfyui\Comfyui-WF-2026.8.8'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$url = 'http://localhost:5679'
# Run in a child process because the ComfyUI launcher exits when already running.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-comfyui.ps1') -PackagePath $PackagePath
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI failed to start. Check tmp/comfyui/server.stderr.log' }
function Test-Huobao {
  try { return (Invoke-RestMethod "$url/api/v1/health" -TimeoutSec 2).status -eq 'ok' } catch { return $false }
}
if (!(Test-Huobao)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
  if (!(Test-Path -LiteralPath $nodePath)) { throw 'Node.js was not found. Install Node.js and try again.' }
  $cli = Join-Path $repoRoot 'backend\node_modules\tsx\dist\cli.mjs'
  $frontend = Join-Path $repoRoot 'frontend\.output\public'
  if (!(Test-Path -LiteralPath $cli)) { throw 'Backend dependencies are missing.' }
  if (!(Test-Path -LiteralPath (Join-Path $frontend 'index.html'))) { throw 'Frontend build is missing. Generate the frontend first.' }
  $logs = Join-Path $repoRoot 'data\launcher'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $env:FRONTEND_DIST = $frontend
  $env:PORT = '5679'
  # Node fetch does not inherit the Windows proxy automatically.
  if (!$env:HTTPS_PROXY -and !$env:HTTP_PROXY) {
    $systemProxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($systemProxy.ProxyEnable -eq 1 -and $systemProxy.ProxyServer) {
      $proxyAddress = [string]$systemProxy.ProxyServer
      if ($proxyAddress -match '(?:^|;)https=([^;]+)') { $proxyAddress = $Matches[1] }
      elseif ($proxyAddress -match '(?:^|;)http=([^;]+)') { $proxyAddress = $Matches[1] }
      if ($proxyAddress -notmatch '://') { $proxyAddress = 'http://' + $proxyAddress }
      $env:HTTPS_PROXY = $proxyAddress
      $env:HTTP_PROXY = $proxyAddress
    }
  }
  $nodeArgs = @()
  if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
    $env:NO_PROXY = 'localhost,127.0.0.1,::1' + $(if ($env:NO_PROXY) { ',' + $env:NO_PROXY } else { '' })
    $env:NODE_USE_ENV_PROXY = '1'
    $nodeArgs += '--use-env-proxy'
  }
  $server = Start-Process -FilePath $nodePath -ArgumentList ($nodeArgs + @("`"$cli`"", 'src/index.ts')) -WorkingDirectory (Join-Path $repoRoot 'backend') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server-error.log') -PassThru
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Huobao) { break }
    if ($server.HasExited) { throw "Server failed to start. See $logs\server-error.log" }
    Start-Sleep -Milliseconds 500
  }
  if (!(Test-Huobao)) { throw "Server startup timed out. See $logs\server-error.log" }
}
if (!$NoBrowser) { Start-Process $url }
Write-Host "Huobao is ready: $url"


