param([string]$PackagePath = 'D:\comfyui\Comfyui-WF-2026.8.8')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$helper = Join-Path $PSScriptRoot 'local-runtime-host.ps1'
Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$helper`"",'-PackagePath',"`"$PackagePath`"") -WindowStyle Hidden
$runtimeDir = Join-Path $repoRoot 'data\local-runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$request = @{ id=[Guid]::NewGuid().ToString(); action='start-comfyui'; createdAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $runtimeDir 'request.json'), $request, (New-Object Text.UTF8Encoding($false)))
$dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$dockerReady = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  & docker info *> $null
  if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
  if ($attempt -eq 0 -and (Test-Path -LiteralPath $dockerDesktop)) { Start-Process -FilePath $dockerDesktop -WindowStyle Hidden }
  Start-Sleep -Seconds 2
}
if (!$dockerReady) { throw 'Docker Desktop did not start. Please open Docker Desktop and try again.' }
Push-Location $repoRoot
try { & docker compose up -d --no-build app; if ($LASTEXITCODE -ne 0) { throw 'Huobao container failed to start' } } finally { Pop-Location }
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5679/api/v1/health' -TimeoutSec 2; if ($health.status -eq 'ok') { Start-Process 'http://localhost:5679'; exit 0 } } catch {}
  Start-Sleep -Seconds 1
}
throw 'Huobao did not become ready. Check docker compose logs app.'
