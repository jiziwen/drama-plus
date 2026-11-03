param(
  [string]$PackagePath = 'D:\comfyui\Comfyui-WF-2026.8.8',
  [string]$DataPath = (Join-Path $PSScriptRoot '..\data'),
  [int]$Port = 8188
)
$ErrorActionPreference = 'Stop'
$identity = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($DataPath))).Replace('\', '').Replace('/', '').Replace('=', '')
$mutex = New-Object Threading.Mutex($false, "Local\HuobaoRuntime-$identity")
if (!$mutex.WaitOne(0)) { exit 0 }
$runtimeDir = Join-Path $DataPath 'local-runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$lastRequest = ''
$launchAt = $null
$launchPid = $null
$lastError = ''
try {
  while ($true) {
    $ready = $false
    try {
      $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/system_stats" -TimeoutSec 2
      $ready = $null -ne $stats.system
    } catch {}
    try {
      $request = Get-Content -LiteralPath (Join-Path $runtimeDir 'request.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($request.action -eq 'start-comfyui' -and $request.id -ne $lastRequest -and ([DateTime]::UtcNow - [DateTime]::Parse($request.createdAt).ToUniversalTime()).TotalMinutes -lt 2) {
        $lastRequest = $request.id
        if (!$ready -and $null -eq $launchAt) {
          $pythonPath = Join-Path $PackagePath 'python\python.exe'
          $comfyRoot = Join-Path $PackagePath 'ComfyUI'
          if (!(Test-Path -LiteralPath $pythonPath) -or !(Test-Path -LiteralPath (Join-Path $comfyRoot 'main.py'))) { throw "ComfyUI package not found at $PackagePath" }
          $logRoot = Join-Path $PSScriptRoot '..\tmp\comfyui'
          New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
          $process = Start-Process -FilePath $pythonPath -ArgumentList @('-u','main.py','--listen','0.0.0.0','--port',"$Port",'--disable-auto-launch','--lowvram') -WorkingDirectory $comfyRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'server.stdout.log') -RedirectStandardError (Join-Path $logRoot 'server.stderr.log') -PassThru
          $launchPid = $process.Id
          $launchAt = [DateTime]::UtcNow
          $lastError = ''
        }
      }
    } catch [System.Management.Automation.ItemNotFoundException] {} catch { $lastError = $_.Exception.Message }
    if ($ready) { $launchAt = $null; $lastError = '' }
    if ($null -ne $launchAt) {
      if (!(Get-Process -Id $launchPid -ErrorAction SilentlyContinue)) { $lastError = 'ComfyUI exited during startup. Check tmp/comfyui/server.stderr.log'; $launchAt = $null }
      elseif (([DateTime]::UtcNow - $launchAt).TotalMinutes -gt 5) { $lastError = 'ComfyUI startup exceeded 5 minutes. Check the startup log.'; $launchAt = $null }
    }
    $status = if ($ready) { 'ready' } elseif ($null -ne $launchAt) { 'starting' } elseif ($lastError) { 'error' } else { 'idle' }
    $state = @{ status=$status; updatedAt=[DateTime]::UtcNow.ToString('o'); port=$Port; processId=$launchPid; error=$lastError; packagePath=$PackagePath }
    $json = $state | ConvertTo-Json -Compress
    $temporary = Join-Path $runtimeDir "status-$PID.tmp"
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination (Join-Path $runtimeDir 'status.json') -Force
    Start-Sleep -Seconds 3
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
