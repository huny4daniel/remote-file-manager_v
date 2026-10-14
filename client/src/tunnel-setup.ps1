# 내장 WireGuard 터널 설치 — 클라이언트가 처음 한 번(또는 터널 파일이 바뀐 새 버전에서) UAC로 실행한다.
#   - %ProgramData%\RemoteFileManager\tunnel : tunnel.dll, wireguard.dll, rfm-tunnel-host.exe
#     (SYSTEM이 실행하는 파일이라 SYSTEM/관리자만 쓰기 가능, 사용자는 읽기만 — 버전 비교용)
#   - %ProgramData%\RemoteFileManager\conf   : 시작 직전에 클라이언트가 rfm.conf를 쓰고 시작 직후 지운다
#     (SYSTEM/관리자 + 설치한 사용자만 접근)
#   - WireGuardTunnel$rfm 서비스(수동 시작, SID 종류 UNRESTRICTED)를 만들고 설치한 사용자에게
#     시작/중지/상태 조회 권한을 준다 — 이후엔 관리자 권한 없이 켜고 끈다.
param(
    [Parameter(Mandatory)] [string]$Source,
    [Parameter(Mandatory)] [string]$UserSid,
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'
try {
    if ($UserSid -notmatch '^S-1-[\d-]+$') { throw "잘못된 사용자 SID: $UserSid" }
    $root = Join-Path $env:ProgramData 'RemoteFileManager'
    $bin = Join-Path $root 'tunnel'
    $confDir = Join-Path $root 'conf'
    $svc = 'WireGuardTunnel$rfm'
    $files = 'tunnel.dll', 'wireguard.dll', 'rfm-tunnel-host.exe'

    New-Item -ItemType Directory -Force $bin, $confDir | Out-Null
    & icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls 실패' }
    & icacls.exe $confDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${UserSid}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls 실패' }

    # 실행 중이면 파일을 바꿀 수 없으니 멈춘다
    $existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($existing -and $existing.Status -ne 'Stopped') {
        Stop-Service -Name $svc -Force
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    }
    foreach ($f in $files) {
        $src = Join-Path $Source $f
        if (-not (Test-Path -LiteralPath $src)) { throw "내장 WireGuard 파일이 없습니다: $f" }
        Copy-Item -LiteralPath $src -Destination (Join-Path $bin $f) -Force
    }

    $exe = Join-Path $bin 'rfm-tunnel-host.exe'
    $conf = Join-Path $confDir 'rfm.conf'
    $binPath = "`"$exe`" /service `"$conf`""
    if ($existing) {
        & sc.exe config $svc binPath= $binPath start= demand | Out-Null
    } else {
        New-Service -Name $svc -BinaryPathName $binPath -DisplayName 'RemoteFileManager WireGuard 터널' `
            -StartupType Manual -DependsOn 'Nsi', 'TcpIp' | Out-Null
    }
    # embeddable-dll-service README: "absolutely essential; do not forget it."
    & sc.exe sidtype $svc unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'sc sidtype 실패' }

    # 설치한 사용자에게 시작(RP)/중지(WP)/상태 조회(LC, LO)/읽기(RC) 권한
    $sd = ((& sc.exe sdshow $svc) -join '').Trim()
    $ace = "(A;;RPWPLCLORC;;;$UserSid)"
    if (-not $sd.Contains($ace)) {
        $sd = $sd -replace '^D:', "D:$ace"
        & sc.exe sdset $svc $sd | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'sc sdset 실패' }
    }
    exit 0
} catch {
    if ($LogFile) { $_.Exception.Message | Out-File -FilePath $LogFile -Encoding utf8 }
    exit 1
}
