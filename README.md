# RemoteFileManager

노트북에서 실행하면 **집 PC의 파일 시스템이 Windows 탐색기처럼 열리고**, 원하는 폴더에서 **집 PC에 설치된 Claude Code**를 바로 실행할 수 있는 도구입니다.
WireGuard 등으로 집 내부망에 접속되어 있다는 전제에서 내부망 주소로 직접 연결합니다.

```
노트북 (client, Electron)  ──WireGuard──▶  집 PC (server, Electron 트레이 앱)
  탐색기 UI / 터미널 창                       파일 API · PTY(Claude Code, PowerShell)
```

## 구성

| 폴더 | 실행 위치 | 역할 |
| --- | --- | --- |
| `server/` | 집 PC | 파일 조작 REST API, 터미널(PTY) WebSocket, 트레이 앱(방화벽·자동 실행 관리) |
| `client/` | 노트북 | Windows 11 탐색기 형태의 앱, 원격 터미널 창 |

## 집 PC (서버) 설치

요구 사항: Claude Code 설치 및 로그인(`claude` 명령이 PATH에 있어야 함). Node.js는 필요 없습니다.

1. [Releases](https://github.com/huny4daniel/remote-file-manager_v/releases)에서 `RemoteFileManager-Server_vX.Y.Z.exe`를 받아 원하는 곳(예: 바탕 화면)에 둡니다.
2. 더블클릭합니다. 처음 한 번 관리자 권한(UAC) 확인 창이 뜹니다 — 방화벽 허용과 자동 실행 등록을 한 번에 합니다.
3. 노트북에서 입력할 접속 주소(예: `192.168.0.10:7420`)가 표시됩니다. 이후에는 트레이 아이콘으로 실행됩니다.

- **Windows 시작 시 자동 실행 (로그인 전부터)**: 처음 실행할 때 켜집니다. [WireWOL 컴패니언](https://github.com/huny4daniel/wire-wol_v)과 같은 구조입니다.
  - 컴퓨터가 켜지면 **아무도 로그인하지 않아도** 작업 스케줄러(`RemoteFileManager Server` 작업)가 서버를 내 계정으로 실행합니다(“로그온 여부와 관계없이 실행”, 비밀번호는 저장하지 않음). 그래서 노트북에서 PC를 원격으로 켜면 바로 접속할 수 있습니다.
  - 로그인하면 트레이 아이콘만 뜨고 이미 돌고 있는 서버를 관리합니다(서버가 없거나 옛 버전이면 트레이가 새로 띄웁니다).
  - 두 등록 모두 exe 옆에 만들어지는 `remotefilemanager-server_launcher.vbs`를 거칩니다. 이 런처가 같은 폴더에서 **가장 최근의 `RemoteFileManager-Server_v*.exe`**를 실행하므로, 새 버전은 **같은 폴더에 받기만 하면** 다시 등록할 필요가 없습니다(다른 폴더로 옮기면 처음 실행할 때 UAC로 다시 등록).
- 트레이 메뉴: 접속 주소 복사, 접속 정보 보기, 자동 실행 켜기/끄기, 설정 파일 열기, 로그 열기, 다시 시작, 제거, 종료
- 제거: 트레이 메뉴 → **제거...** (자동 실행 작업·런처·방화벽 규칙·설정 삭제) 후 exe를 지웁니다.
- 설정·로그 위치: `%APPDATA%\RemoteFileManager Server\` (`config.json`, `server.log`). 설정을 바꾸면 트레이 메뉴 → 다시 시작
- 개발: `cd server && npm install` 후 `npm run dev`(Node로 서버만 실행) / `npm run app`(트레이 앱) / `npm run dist`(exe 빌드 → `server/release/`)

### config.json

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `host` | `0.0.0.0` | 바인딩 주소. WireGuard 인터페이스 IP만 쓰려면 해당 IP |
| `port` | `7420` | 포트 |
| `allowedIps` | 사설 대역 전체 | 접속 허용 IPv4 CIDR. 인증이 없으므로 WireGuard/내부망 대역으로 좁히는 것을 권장 |
| `shell` | `powershell.exe` | 터미널 셸 |
| `claudeCommand` | `claude` | Claude Code 실행 명령 |
| `scrollbackBytes` | `524288` | 재연결 시 다시 보내는 터미널 출력 버퍼 크기 |

## 노트북 (클라이언트)

- 개발 실행: `cd client && npm install && npm start`
- 실행 파일 빌드: `npm run dist` → `client/dist/RemoteFileManager_v<버전>.exe` (설치 없이 더블클릭 실행)
- 릴리즈: `vX.Y.Z` 태그를 푸시하면 GitHub Actions가 노트북용 exe와 집 PC용 서버 exe를 빌드해 [Releases](https://github.com/huny4daniel/remote-file-manager_v/releases)에 올림
- **PC 선택 화면**: 실행할 때마다 등록된 PC 목록(온라인 여부 표시)에서 접속할 PC를 고릅니다. `PC 추가`로 여러 대를 등록할 수 있고, 카드 우클릭(또는 `...`)으로 이름 바꾸기(F2)·목록에서 삭제(Delete)를 합니다. 탐색 중에는 상태 표시줄의 PC 이름이나 `...` 메뉴 → 다른 PC 선택으로 돌아갑니다.
  - PC 이름은 처음엔 원격 컴퓨터 이름으로 자동 등록되며, 바꾼 이름은 그대로 유지됩니다.
- **WireWOL 내장** ([WireWOL PC](https://github.com/huny4daniel/wire-wol-pc_v)를 옮긴 것 — 별도 앱 없이 동작)
  - **WireGuard**: 프로그램을 켜면 집 PC에 바로 닿지 않을 때(집 밖) 내장 WireGuard를 켜고, 프로그램을 끝낼 때 함께 끕니다. 집 안이거나 다른 VPN으로 이미 닿으면 켜지 않습니다.
    - 터널은 등록된 PC가 있는 대역(/24)만 맡습니다. `.conf`의 AllowedIPs·DNS는 무시하므로 노트북의 다른 인터넷 통신은 터널을 거치지 않고, 터널이 막혀도 인터넷이 끊기지 않습니다.
    - 노트북이 PC와 같은 망에 있으면(집 안) PC가 꺼져 있어도 터널을 켜지 않습니다. 켜 둔 채로 망이 바뀌면 15초 안에 다시 판단해, 집에 들어오면 터널을 끕니다. 처음 한 번만 `설치`(UAC)가 필요하고, 이후엔 관리자 권한 없이 켜고 끕니다.
  - **PC 켜기**: PC를 골랐는데 꺼져 있으면 자동으로 켜고(매직 패킷 + 설정 시 공유기 원격 WOL), 서버가 응답하면 바로 접속합니다. 카드의 `PC 켜기` 버튼으로 켤 수도 있습니다.
  - **PC 끄기**: 탐색기 도구 모음의 `PC 끄기`(10초 뒤 종료, 알림에서 취소) / 옆 메뉴의 예약 끄기·예약 취소. 집 PC 서버가 처리하며, 서버가 응답하지 않으면 WireWOL 컴패니언(연결 정보가 있을 때)으로 보냅니다.
    - 집 밖이면 WireGuard부터 켜고 보냅니다. 응답이 없으면(절전 상태) 깨우기 신호를 보낸 뒤 30초 동안 1초마다 확인하다가, 응답하는 즉시 한 번 더 보냅니다.
    - 끄기·예약 끄기에 성공하면 예약 시각부터 5초마다 PC를 확인해 꺼진 것이 확인되면 WireGuard도 끕니다(10분 안에 안 꺼지면 그만둠). 다른 PC가 터널로 응답 중이면 끄지 않고, 종료 취소·PC 켜기·WireGuard 직접 켜기를 하면 해제됩니다.
  - **PC 상태**: 카드마다 켜짐 / 켜짐 · 서버 꺼짐(컴패니언만 응답) / 꺼짐 / 응답 없음(WireGuard 필요) / 종료 예약 시각을 5초마다 갱신합니다.
  - **WireWOL 설정**(선택 화면 오른쪽 위): WireGuard `.conf` 불러오기, 공유기 원격 WOL, 설정 파일(`wirewol_settings.json`) 불러오기/내보내기 — WireWOL 안드로이드/PC 앱과 같은 형식이라 서로 옮길 수 있습니다. PC별 MAC·컴패니언 정보는 카드 메뉴 → WireWOL 연결 정보.
  - 비밀 값(WireGuard 개인키, 컴패니언 토큰, 공유기 비밀번호)은 Windows 계정에 묶인 DPAPI로 암호화해 저장합니다. 내장 터널은 `%ProgramData%\RemoteFileManager\`에 설치되는 `WireGuardTunnel$rfm` 서비스입니다.
  - 내장 터널 빌드(개발 시): `pwsh -File client/tunnel/build_tunnel.ps1` (mingw-w64 gcc 필요, Go는 자동으로 받음)

## 기능

**탐색기**
- 내 PC(폴더·드라이브 사용량), 탐색 창, 주소 표시줄(클릭해서 경로 입력), 하위 폴더 검색
- 자세히 / 큰 아이콘 보기, 열 정렬, 다중 선택(Ctrl/Shift/드래그 사각형), 이름 첫 글자로 이동
- 새 폴더 / 새 텍스트 문서, 이름 바꾸기(F2), 삭제(항상 휴지통으로), 속성(Alt+Enter)
- **실행 취소(Ctrl+Z) / 다시 실행(Ctrl+Y)**: 이름 바꾸기, 새로 만들기, 복사, 이동, 휴지통 삭제(휴지통에서 원래 위치로 복원). 노트북 → 집 PC 업로드는 되돌리지 않습니다.
- 복사·잘라내기·붙여넣기, 끌어서 이동(Ctrl: 복사), 이름 충돌 시 덮어쓰기/건너뛰기/둘 다 유지
- **노트북 탐색기에서 Ctrl+C 한 파일을 Ctrl+V** 하거나 끌어다 놓으면 집 PC로 업로드
- 파일 더블클릭 → 노트북 기본 앱으로 열림, **저장하면 자동으로 집 PC에 반영**
- 바로 가기(.lnk) 따라가기, 내 노트북에 저장(폴더 포함)
- 아이콘·확장명 표시·숨김 파일 표시는 노트북 Windows 설정을 그대로 따름
- 다른 프로그램(Claude Code 등)이 바꾼 내용은 자동으로 새로 고침
- 단축키: Ctrl+C/X/V, Ctrl+Insert/Shift+Insert, Ctrl+A, Ctrl+Z/Y(Ctrl+Shift+Z), Delete/Ctrl+D, F2, Enter, Ctrl+Enter(새 창에서 열기), Alt+Enter, Shift+F10(메뉴), Alt+←/→/↑, Backspace, F5/Ctrl+R, Ctrl+L/Alt+D/F4, Ctrl+F/Ctrl+E/F3, Ctrl+N, Ctrl+Shift+N, Ctrl+Shift+C(경로 복사), Ctrl+Shift+2/6 또는 Ctrl+휠(보기 전환), Ctrl+W

**터미널 (Claude Code / PowerShell)**
- 도구 모음의 `Claude Code` 버튼 또는 우클릭 → 여기서 Claude Code 열기 / 이전 대화 이어서 열기(`--continue`) / 터미널에서 열기
- 원격 PC에서 실제 PTY로 실행 (Claude Code 종료 후에도 같은 위치의 PowerShell 유지)
- 네트워크가 끊겨도 세션은 서버에 유지되고 자동 재연결 시 화면 복원. 분리된 세션은 `...` → 실행 중인 터미널에서 다시 열기
- Ctrl+C(선택 시 복사)/Ctrl+V, 우클릭 복사/붙여넣기, Shift+Enter 줄바꿈, Ctrl+± 글자 크기
- **노트북의 이미지/파일을 붙여넣거나 끌어다 놓으면** 집 PC(`~\.remote-file-manager\inbox`)로 보낸 뒤 그 경로를 입력 → Claude Code가 바로 읽을 수 있음
- 창을 닫으면 원격 프로세스도 종료

## 보안 참고

인증 없이 동작하므로 **WireGuard로 보호되는 네트워크 안에서만** 사용하세요. `allowedIps`와 방화벽 규칙이 허용 대역 밖의 접근을 막습니다. 포트를 공유기에서 외부로 포워딩하지 마세요.
