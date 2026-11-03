param(
  [string]$PackagePath = 'D:\comfyui\Comfyui-WF-2026.8.8',
  [int]$Port = 8188
)
$ErrorActionPreference = 'Stop'
$pythonPath = Join-Path $PackagePath 'python\python.exe'
$comfyRoot = Join-Path $PackagePath 'ComfyUI'
if (!(Test-Path -LiteralPath $pythonPath) -or !(Test-Path -LiteralPath (Join-Path $comfyRoot 'main.py'))) {
  throw "ComfyUI package not found at $PackagePath"
}
try {
  $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/system_stats" -TimeoutSec 3
  if ($stats.system) { Write-Output "ComfyUI is already running on port $Port"; exit 0 }
} catch {}
$logRoot = Join-Path $PSScriptRoot '..\tmp\comfyui'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$process = Start-Process -FilePath $pythonPath -ArgumentList @('-u', 'main.py', '--listen', '0.0.0.0', '--port', "$Port", '--disable-auto-launch', '--lowvram') -WorkingDirectory $comfyRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'server.stdout.log') -RedirectStandardError (Join-Path $logRoot 'server.stderr.log') -PassThru
Write-Output "Started ComfyUI (PID $($process.Id)) on port $Port. Logs: $logRoot"
