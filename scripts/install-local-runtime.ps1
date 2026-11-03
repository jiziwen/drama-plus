param([string]$PackagePath = 'D:\comfyui\Comfyui-WF-2026.8.8')
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$launcher = Join-Path $PSScriptRoot 'start-huobao.ps1'
$helper = Join-Path $PSScriptRoot 'local-runtime-host.ps1'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$desktopName = -join @([char]0x706B,[char]0x5B9D,[char]0x77ED,[char]0x5267)
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$desktopName.lnk"
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Huobao Local Runtime.lnk'
foreach ($item in @(@{ path=$desktopLink; script=$launcher; description='Open Huobao and start local ComfyUI' }, @{ path=$startupLink; script=$helper; description='Local ComfyUI startup helper for Huobao' })) {
  $shortcut = $shell.CreateShortcut($item.path)
  $shortcut.TargetPath = $powershellPath
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($item.script)`" -PackagePath `"$PackagePath`""
  $shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
  $shortcut.WindowStyle = 7
  $shortcut.Description = $item.description
  $shortcut.Save()
}
Start-Process -FilePath $powershellPath -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$helper`"",'-PackagePath',"`"$PackagePath`"") -WindowStyle Hidden
Write-Output "Desktop launcher: $desktopLink"
Write-Output "Login helper: $startupLink"
