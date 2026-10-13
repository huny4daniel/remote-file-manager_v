# 자동 실행/방화벽 규칙 제거.  사용: 관리자 PowerShell에서  .\uninstall.ps1
#Requires -RunAsAdministrator
$name = 'RemoteFileManager Server'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$pidFile = Join-Path $PSScriptRoot 'server.pid'
if (Test-Path $pidFile) {
  Stop-Process -Id ([int](Get-Content $pidFile)) -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile
}
Write-Host '제거했습니다.'
