# 집 PC에서 한 번 실행: 빌드 → 설정 파일 생성 → 방화벽 허용 → 로그인 시 자동 실행 등록 → 바로 시작
# 사용: 관리자 PowerShell에서  .\install.ps1
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js가 설치되어 있지 않습니다 (https://nodejs.org).' }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Warning 'claude 명령을 찾을 수 없습니다. Claude Code를 먼저 설치하고 로그인하세요.' }

Write-Host '의존성 설치 및 빌드...' -ForegroundColor Cyan
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { npm install --no-audit --no-fund }
npm run build
if ($LASTEXITCODE -ne 0) { throw '빌드 실패' }

if (-not (Test-Path "$root\config.json")) {
  Copy-Item "$root\config.example.json" "$root\config.json"
  Write-Host 'config.json 을 만들었습니다 (필요하면 allowedIps/port 수정).' -ForegroundColor Yellow
}
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$port = if ($cfg.port) { $cfg.port } else { 7420 }

# 방화벽: 허용 대역에서만 들어오도록 제한
$ruleName = 'RemoteFileManager Server'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$remote = if ($cfg.allowedIps -and $cfg.allowedIps.Count) { [string[]]$cfg.allowedIps } else { @('Any') }
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress $remote -Action Allow -Profile Any | Out-Null
Write-Host "방화벽 규칙 추가: TCP $port ($($remote -join ', '))" -ForegroundColor Green

# 로그인 시 현재 사용자 권한으로 숨김 실행 (Claude Code 로그인 정보/설정을 그대로 쓰기 위해 사용자 세션에서 실행)
$taskName = 'RemoteFileManager Server'
$node = (Get-Command node).Source
$log = Join-Path $root 'server.log'
$cmd = "Set-Location -LiteralPath '$root'; & '$node' dist/index.js *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "자동 실행 등록 및 시작: 작업 스케줄러 '$taskName'" -ForegroundColor Green

Start-Sleep 3
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host '노트북 앱에서 아래 주소 중 내부망 주소로 연결하세요:' -ForegroundColor Cyan
$ips | ForEach-Object { Write-Host "  $_`:$port" }
Write-Host "로그: $log"
