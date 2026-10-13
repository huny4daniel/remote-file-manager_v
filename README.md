# RemoteFileManager

노트북에서 실행하면 **집 PC의 파일 시스템이 Windows 탐색기처럼 열리고**, 원하는 폴더에서 **집 PC에 설치된 Claude Code**를 바로 실행할 수 있는 도구입니다.
WireGuard 등으로 집 내부망에 접속되어 있다는 전제에서 내부망 주소로 직접 연결합니다.

```
노트북 (client, Electron)  ──WireGuard──▶  집 PC (server, Node.js)
  탐색기 UI / 터미널 창                       파일 API · PTY(Claude Code, PowerShell)
```

## 구성

| 폴더 | 실행 위치 | 역할 |
| --- | --- | --- |
| `server/` | 집 PC | 파일 조작 REST API, 터미널(PTY) WebSocket, 로그인 시 자동 실행 |
| `client/` | 노트북 | Windows 11 탐색기 형태의 앱, 원격 터미널 창 |

## 집 PC (서버) 설치

요구 사항: Node.js 20 이상, Claude Code 설치 및 로그인(`claude` 명령이 PATH에 있어야 함)

1. `server` 폴더를 집 PC에 복사
2. **관리자 PowerShell**에서
   ```powershell
   cd server
   .\install.ps1
   ```
   - 빌드, `config.json` 생성, 방화벽 규칙(허용 대역만) 추가
   - 작업 스케줄러에 등록해 **로그인할 때 사용자 권한으로 숨김 실행**하고 즉시 시작
3. 마지막에 출력되는 내부망 주소(예: `192.168.0.10:7420`)를 기억

제거: `.\uninstall.ps1` / 수동 실행(개발): `npm run dev`

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
- 릴리즈: `vX.Y.Z` 태그를 푸시하면 GitHub Actions가 exe와 서버 패키지(zip)를 빌드해 [Releases](https://github.com/huny4daniel/remote-file-manager_v/releases)에 올림
- 첫 실행 시 집 PC 주소를 입력하면 이후 자동 연결 (`...` 메뉴 → 다른 PC에 연결)
- **WireWOL 설정 파일로 연결**: 연결 창에서 `WireWOL 설정 파일로 연결...`을 누르거나 `wirewol_settings.json`을 끌어다 놓고 내보낼 때 정한 비밀번호를 입력하면, 파일에 등록된 PC 주소로 바로 연결합니다(포트는 remote-file-manager 서버의 7420).
  - 파일에서는 PC 주소와 MAC만 가져오고, 토큰·WireGuard 키·공유기 계정은 저장하지 않습니다. WireGuard는 지금처럼 WireWOL PC 앱으로 켜면 됩니다.
  - PC가 꺼져 있어 연결되지 않으면 `PC 켜기` 버튼이 나타납니다. WireWOL과 같은 방식으로 매직 패킷을 보낸 뒤, PC가 켜져 서버가 응답할 때까지 자동으로 다시 연결합니다.

## 기능

**탐색기**
- 내 PC(폴더·드라이브 사용량), 탐색 창, 주소 표시줄(클릭해서 경로 입력), 하위 폴더 검색
- 자세히 / 큰 아이콘 보기, 열 정렬, 다중 선택(Ctrl/Shift/드래그 사각형), 이름 첫 글자로 이동
- 새 폴더 / 새 텍스트 문서, 이름 바꾸기(F2), 삭제(휴지통) / 영구 삭제(Shift+Delete)
- 복사·잘라내기·붙여넣기, 끌어서 이동(Ctrl: 복사), 이름 충돌 시 덮어쓰기/건너뛰기/둘 다 유지
- **노트북 탐색기에서 Ctrl+C 한 파일을 Ctrl+V** 하거나 끌어다 놓으면 집 PC로 업로드
- 파일 더블클릭 → 노트북 기본 앱으로 열림, **저장하면 자동으로 집 PC에 반영**
- 바로 가기(.lnk) 따라가기, 내 노트북에 저장(폴더 포함)
- 아이콘·확장명 표시·숨김 파일 표시는 노트북 Windows 설정을 그대로 따름
- 다른 프로그램(Claude Code 등)이 바꾼 내용은 자동으로 새로 고침
- 단축키: Alt+←/→/↑, Backspace, F5, Ctrl+L, Ctrl+F, Ctrl+N, Ctrl+Shift+N, Ctrl+Shift+C(경로 복사), Ctrl+W

**터미널 (Claude Code / PowerShell)**
- 도구 모음의 `Claude Code` 버튼 또는 우클릭 → 여기서 Claude Code 열기 / 이전 대화 이어서 열기(`--continue`) / 터미널에서 열기
- 원격 PC에서 실제 PTY로 실행 (Claude Code 종료 후에도 같은 위치의 PowerShell 유지)
- 네트워크가 끊겨도 세션은 서버에 유지되고 자동 재연결 시 화면 복원. 분리된 세션은 `...` → 실행 중인 터미널에서 다시 열기
- Ctrl+C(선택 시 복사)/Ctrl+V, 우클릭 복사/붙여넣기, Shift+Enter 줄바꿈, Ctrl+± 글자 크기
- **노트북의 이미지/파일을 붙여넣거나 끌어다 놓으면** 집 PC(`~\.remote-file-manager\inbox`)로 보낸 뒤 그 경로를 입력 → Claude Code가 바로 읽을 수 있음
- 창을 닫으면 원격 프로세스도 종료

## 보안 참고

인증 없이 동작하므로 **WireGuard로 보호되는 네트워크 안에서만** 사용하세요. `allowedIps`와 방화벽 규칙이 허용 대역 밖의 접근을 막습니다. 포트를 공유기에서 외부로 포워딩하지 마세요.
