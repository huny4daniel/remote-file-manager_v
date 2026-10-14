// 집 PC용 서버 앱. WireWOL 컴패니언(github.com/huny4daniel/wire-wol_v의 windows/)과 같은 구조로 실행 방식이 둘로 나뉜다.
//   --server : 트레이 없는 헤드리스 서버. 작업 스케줄러가 부팅 즉시(로그인 전) 내 계정(S4U, 비밀번호 저장 없음)으로 띄운다
//              — 원격으로 PC를 켜면 아무도 로그인하지 않아도 노트북에서 바로 접속할 수 있다.
//   (그 외)  : 트레이. 로그인 시 시작프로그램(--tray) 또는 더블클릭으로 뜬다. 백그라운드 서버가 이미 돌고 있으면 트레이만
//              띄우고, 없거나 옛 버전이면 이 프로세스 안에서 서버를 띄운다.
// 두 등록 모두 exe를 직접 가리키지 않고 exe 옆의 고정 경로 런처(VBScript)를 가리킨다. 런처는 실행될 때마다 같은 폴더에서
// 가장 최근의 RemoteFileManager-Server_v*.exe를 찾아 실행하므로, 새 버전 exe를 같은 폴더에 받으면 다시 등록할 필요가 없다.
import { app, Tray, Menu, dialog, shell, clipboard, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { defaultConfig, loadConfig } from '../dist/config.js';
import { lanAddresses, startServer } from '../dist/server.js';

const APP_NAME = 'RemoteFileManager Server';
const RULE_NAME = 'RemoteFileManager Server';
const TASK_NAME = 'RemoteFileManager Server';
const LAUNCHER_NAME = 'remotefilemanager-server_launcher.vbs';
const SHORTCUT_NAME = 'RemoteFileManager Server.lnk';
const EXE_PREFIX = 'remotefilemanager-server_';

const SERVER_MODE = process.argv.includes('--server');
const SILENT = SERVER_MODE || process.argv.includes('--tray') || process.argv.includes('--autostart');

app.setAppUserModelId('remotefilemanager.server');
// 부팅 직후의 비대화형 세션에는 GPU가 없다
if (SERVER_MODE) app.disableHardwareAcceleration();
// 같은 사용자 데이터 폴더를 쓰는 두 프로세스(백그라운드 서버 / 트레이)가 브라우저 캐시를 다투지 않게 나눈다
app.setPath('sessionData', path.join(app.getPath('userData'), SERVER_MODE ? 'session-server' : 'session-tray'));
// 트레이는 하나만. 백그라운드 서버는 다른 세션에서 돌 수 있어 잠금 대신 포트로 중복을 막는다
if (!SERVER_MODE && !app.requestSingleInstanceLock()) app.quit();

const dataDir = () => app.getPath('userData');
const configFile = () => path.join(dataDir(), 'config.json');
const logFile = () => path.join(dataDir(), 'server.log');
// portable exe는 실행할 때마다 임시 폴더에 풀리므로, 등록에는 원래 exe의 폴더를 쓴다
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const exeDir = () => path.dirname(exePath());
const launcherPath = () => path.join(exeDir(), LAUNCHER_NAME);
const shortcutPath = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', SHORTCUT_NAME);
const wscript = () => path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');

// 개발 실행(npm run app)에서는 방화벽 규칙·자동 실행 같은 시스템 설정을 건드리지 않는다
const touchSystem = app.isPackaged && !process.env.REMOTE_FILE_MANAGER_NO_SYSTEM;

let tray = null;
let running = null; // 이 프로세스 안에서 돈 서버
let external = null; // 백그라운드 서버의 /api/info (트레이만 띄운 경우)
let cfg = null;

// ───────────────────────── 로그 ─────────────────────────
function setupLog() {
  fs.mkdirSync(dataDir(), { recursive: true });
  try {
    if (fs.statSync(logFile()).size > 5 * 1024 * 1024) fs.rmSync(logFile());
  } catch {
    /* 없음 */
  }
  const out = fs.createWriteStream(logFile(), { flags: 'a' });
  const tag = SERVER_MODE ? '[백그라운드] ' : '';
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      out.write(`[${new Date().toLocaleString()}] ${tag}${text}\n`);
    };
  }
  process.on('uncaughtException', (e) => console.error('[오류]', e));
  process.on('unhandledRejection', (e) => console.error('[오류]', e));
}

// ───────────────────────── 설정 ─────────────────────────
function ensureConfig() {
  if (fs.existsSync(configFile())) return false;
  const { host, port, allowedIps } = defaultConfig;
  fs.writeFileSync(configFile(), JSON.stringify({ host, port, allowedIps }, null, 2));
  return true;
}
// 자동 실행을 등록한 exe 폴더 등 앱이 기억할 상태
const stateFile = () => path.join(dataDir(), 'state.json');
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2));
}

// ───────────────────────── 관리자 권한 작업 ─────────────────────────
function powershell(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || '').trim() }),
    );
  });
}
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 관리자 권한(UAC)으로 스크립트 실행. 사용자가 취소하면 false */
async function elevated(script) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64');
  const r = await powershell(
    `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit 1 }`,
  );
  return r.ok;
}

// 포트 기준 규칙 — portable exe는 실행할 때마다 다른 임시 폴더에 풀리므로 프로그램 경로로 묶지 않는다
// (그러면 부팅 때마다 UAC가 필요해지는데 부팅 직후엔 UAC 창을 띄울 수 없다)
const firewallSig = () => 'sig2:' + crypto.createHash('sha1').update(JSON.stringify([cfg.port, cfg.allowedIps])).digest('hex').slice(0, 16);
async function firewallOk() {
  const cur = await powershell(`(Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue | Select-Object -First 1).Description`);
  return cur.out === firewallSig();
}
function firewallScript() {
  const remote = cfg.allowedIps.length ? `@(${cfg.allowedIps.map(psQuote).join(',')})` : "'Any'";
  return [
    `Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -Description ${psQuote(firewallSig())} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${Number(cfg.port)} -RemoteAddress ${remote} -Profile Any | Out-Null`,
  ].join('\n');
}

// ───────────────────────── 자동 실행 (부팅 시 백그라운드 서버 + 로그인 시 트레이) ─────────────────────────
/** 같은 폴더에서 가장 최근에 수정된 RemoteFileManager-Server_v*.exe를 인자 그대로 실행하는 런처 (콘솔 창 없이) */
function writeLauncher() {
  const vbs = [
    'Option Explicit',
    'Dim fso, sh, folder, f, newest, newestTime, found, args, i',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    'Set folder = fso.GetFolder(fso.GetParentFolderName(WScript.ScriptFullName))',
    'found = False',
    'For Each f In folder.Files',
    `    If LCase(Left(f.Name, ${EXE_PREFIX.length})) = "${EXE_PREFIX}" And LCase(Right(f.Name, 4)) = ".exe" Then`,
    '        If (Not found) Or f.DateLastModified > newestTime Then',
    '            newestTime = f.DateLastModified',
    '            Set newest = f',
    '            found = True',
    '        End If',
    '    End If',
    'Next',
    'If found Then',
    '    args = ""',
    '    For i = 0 To WScript.Arguments.Count - 1',
    '        args = args & " " & WScript.Arguments(i)',
    '    Next',
    '    sh.Run """" & newest.Path & """" & args, 0, False',
    'End If',
    '',
  ].join('\r\n');
  fs.writeFileSync(launcherPath(), vbs, 'utf8');
}

function bootTaskScript() {
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  return [
    `$a = New-ScheduledTaskAction -Execute ${psQuote(wscript())} -Argument ${psQuote(`"${launcherPath()}" --server`)} -WorkingDirectory ${psQuote(exeDir())}`,
    '$t = New-ScheduledTaskTrigger -AtStartup',
    // S4U: 로그인 여부와 상관없이 이 계정으로 실행, 비밀번호를 저장하지 않는다
    `$p = New-ScheduledTaskPrincipal -UserId ${psQuote(user)} -LogonType S4U -RunLevel Limited`,
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)',
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
  ].join('\n');
}

const autostartEnabled = () => fs.existsSync(shortcutPath());

/** 부팅 작업 + 로그인 시 트레이 바로가기 등록 (방화벽 규칙도 필요하면 같은 UAC 한 번에) */
async function enableAutostart({ withFirewall = false } = {}) {
  writeLauncher();
  const ok = await elevated([withFirewall ? firewallScript() : '', bootTaskScript()].filter(Boolean).join('\n'));
  if (!ok) return false;
  shell.writeShortcutLink(shortcutPath(), 'create', {
    target: wscript(),
    args: `"${launcherPath()}" --tray`,
    cwd: exeDir(),
    icon: exePath(),
    iconIndex: 0,
    description: APP_NAME,
  });
  // 예전 버전이 등록한 로그인 항목(exe 경로를 직접 가리킴)은 지운다
  app.setLoginItemSettings({ openAtLogin: false });
  writeState({ autostartDir: exeDir() });
  return true;
}

async function disableAutostart() {
  fs.rmSync(shortcutPath(), { force: true });
  app.setLoginItemSettings({ openAtLogin: false });
  writeState({ autostartDir: null });
  return elevated(`Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`);
}

// ───────────────────────── 백그라운드 서버 ─────────────────────────
async function localInfo() {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/info`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    return data?.app === 'remote-file-manager' ? data : null;
  } catch {
    return null;
  }
}
async function localTerminalCount() {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/api/terminals`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).length;
  } catch {
    return 0;
  }
}

/** 백그라운드 서버 끝내기. 부팅 작업(S4U)으로 뜬 프로세스는 같은 계정이어도 직접 종료할 권한이 없어
 *  서버에 스스로 끝나라고 요청하고, 옛 버전이라 그 API가 없으면 UAC로 종료한다 */
async function stopExternal() {
  const pid = external?.pid;
  if (!external) return false;
  const down = async () => !(await localInfo());
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/server/exit`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (!res?.ok) {
    try {
      process.kill(pid);
    } catch {
      if (pid) await elevated(`Stop-Process -Id ${Number(pid)} -Force`);
      else await elevated(`Get-NetTCPConnection -LocalPort ${Number(cfg.port)} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
    }
  }
  for (let i = 0; i < 50 && !(await down()); i++) await new Promise((r) => setTimeout(r, 100));
  external = null;
  return down();
}

async function startHere() {
  running = await startServer(cfg, {
    appVersion: app.getVersion(),
    onExitRequest: SERVER_MODE
      ? () => {
          console.log('트레이 요청으로 종료');
          running.close();
          app.exit(0);
        }
      : undefined,
  });
  console.log(`서버 실행: ${running.addresses.join(', ')} (허용 대역: ${cfg.allowedIps.join(', ') || '전체'})`);
}

// ───────────────────────── 트레이 ─────────────────────────
/** WireGuard 연결 등으로 IP가 바뀌면 표시 주소도 갱신 */
const refreshAddresses = () => (cfg.host === '0.0.0.0' ? lanAddresses() : [cfg.host]).map((h) => `${h}:${cfg.port}`);
let addresses = [];

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: APP_NAME, body }).show();
}

function showInfo() {
  const lines = addresses.length ? addresses.join('\n') : '(네트워크 연결 없음)';
  dialog
    .showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: '원격 PC 서버가 실행 중입니다',
      detail:
        `노트북의 RemoteFileManager에서 아래 주소로 연결하세요.\n\n${lines}\n\n` +
        (autostartEnabled()
          ? '컴퓨터를 켜면 로그인하지 않아도 서버가 자동으로 실행됩니다.'
          : '트레이 메뉴의 "Windows 시작 시 자동 실행"을 켜면 로그인하지 않아도 서버가 실행됩니다.'),
      buttons: ['확인', '주소 복사'],
      defaultId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 1) clipboard.writeText(addresses[0] || '');
    });
}

let menuKey = '';
async function buildMenu(force = false) {
  const n = running ? running.terminals.list().length : await localTerminalCount();
  const where = running ? '' : ' · 백그라운드';
  const key = JSON.stringify([n, addresses, autostartEnabled(), where]);
  if (key === menuKey && !force) return; // 바뀐 게 없으면 열려 있는 메뉴를 건드리지 않는다
  menuKey = key;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `실행 중${where} · 포트 ${cfg.port}${n ? ` · 터미널 ${n}개` : ''}`, enabled: false },
      ...addresses.map((a) => ({ label: `${a} 복사`, click: () => clipboard.writeText(a) })),
      { type: 'separator' },
      { label: '접속 정보 보기', click: showInfo },
      {
        label: 'Windows 시작 시 자동 실행 (로그인 전부터)',
        type: 'checkbox',
        checked: autostartEnabled(),
        click: async (item) => {
          const ok = item.checked ? await enableAutostart() : await disableAutostart();
          if (!ok) notify('관리자 권한 요청이 취소되어 자동 실행 설정을 바꾸지 못했습니다.');
          buildMenu(true);
        },
      },
      { label: '설정 파일 열기', click: () => shell.openPath(configFile()) },
      { label: '로그 열기', click: () => shell.openPath(logFile()) },
      { label: '다시 시작', click: restart },
      { type: 'separator' },
      { label: '제거...', click: uninstall },
      { label: '종료', click: quit },
    ]),
  );
  tray.setToolTip(`${APP_NAME}\n${addresses.join('\n')}`);
}

/** 서버를 이 프로세스 안에서 새로 띄운다 (설정 변경 반영) */
async function restart() {
  if (running) {
    running.close();
    running = null;
  } else await stopExternal();
  cfg = loadConfig(dataDir());
  try {
    await startHere();
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `서버를 다시 시작하지 못했습니다.\n${e.message}`);
  }
  buildMenu(true);
}

async function quit() {
  const n = running ? running.terminals.list().length : await localTerminalCount();
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: APP_NAME,
    message: '서버를 종료할까요?',
    detail:
      (n ? `실행 중인 터미널 ${n}개(Claude Code 포함)도 함께 종료되고, ` : '') +
      '노트북에서 이 PC에 연결할 수 없게 됩니다.' +
      (autostartEnabled() ? '\n다음에 컴퓨터를 켜면 다시 자동으로 실행됩니다.' : ''),
    buttons: ['종료', '취소'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;
  if (running) running.close();
  else await stopExternal();
  app.exit(0);
}

async function uninstall() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: '이 PC에서 서버를 제거할까요?',
    detail: '자동 실행 등록과 방화벽 규칙을 지우고 서버를 종료합니다. 설정과 로그 폴더도 삭제합니다.\n그 뒤 exe 파일을 지우면 완전히 제거됩니다.',
    buttons: ['제거', '취소'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;
  fs.rmSync(shortcutPath(), { force: true });
  fs.rmSync(launcherPath(), { force: true });
  app.setLoginItemSettings({ openAtLogin: false });
  await elevated(
    [
      `Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`,
      `Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    ].join('\n'),
  );
  if (running) running.close();
  else await stopExternal();
  const dir = dataDir();
  // 로그 스트림이 열려 있어 바로 지울 수 없으므로 종료 직후 지운다
  execFile('cmd.exe', ['/c', `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${dir}"`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}

// ───────────────────────── 시작 ─────────────────────────
app.on('second-instance', () => (running || external) && showInfo());
app.on('window-all-closed', () => {
  /* 창 없이 계속 실행 */
});

/** 부팅 작업이 띄우는 헤드리스 서버 — UI도, UAC도 없다 */
async function runServerMode() {
  if (await localInfo()) return app.exit(0); // 이미 실행 중
  try {
    await startHere();
  } catch (err) {
    console.error('[서버 시작 실패]', err);
    app.exit(1);
  }
}

async function runTrayMode(firstRun) {
  if (touchSystem) {
    // 처음 실행이거나 예전 방식(로그인 항목)으로 쓰던 버전에서 올라온 경우(state.json 없음):
    // 방화벽 허용 + 자동 실행(부팅 작업)을 UAC 한 번으로 등록하고 예전 로그인 항목은 지운다
    if (firstRun || !fs.existsSync(stateFile())) {
      if (!(await enableAutostart({ withFirewall: true }))) notify('관리자 권한 요청이 취소되었습니다. 트레이 메뉴에서 자동 실행을 다시 켤 수 있습니다.');
    } else {
      if (!(await firewallOk()) && !(await elevated(firewallScript()))) {
        notify('방화벽 허용이 취소되어 노트북에서 접속하지 못할 수 있습니다. 트레이 메뉴의 다시 시작으로 다시 시도하세요.');
      }
      if (autostartEnabled()) {
        writeLauncher(); // 런처 내용이 바뀐 새 버전 대비
        // exe를 다른 폴더로 옮겼으면 부팅 작업이 옛 폴더의 런처를 가리키므로 다시 등록한다
        if (readState().autostartDir !== exeDir() && !(await enableAutostart())) {
          notify('exe 위치가 바뀌어 자동 실행을 다시 등록해야 합니다. 트레이 메뉴에서 자동 실행을 다시 켜 주세요.');
        }
      }
    }
  }

  external = await localInfo();
  // 백그라운드 서버가 옛 버전이면 이 버전으로 바꿔 띄운다
  if (external && external.appVersion !== app.getVersion()) {
    console.log(`백그라운드 서버(${external.appVersion || '이전 버전'})를 ${app.getVersion()}으로 교체`);
    await stopExternal();
  }
  if (!external) {
    try {
      await startHere();
    } catch (err) {
      console.error(err);
      dialog.showErrorBox(
        APP_NAME,
        err.code === 'EADDRINUSE' ? `포트 ${cfg.port}를 이미 다른 프로그램이 사용 중입니다.` : `서버를 시작하지 못했습니다.\n${err.message}`,
      );
      return app.exit(1);
    }
  }

  addresses = refreshAddresses();
  tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
  tray.on('click', () => tray.popUpContextMenu());
  buildMenu();
  tray.on('right-click', () => buildMenu());
  setInterval(async () => {
    addresses = refreshAddresses();
    // 백그라운드 서버가 꺼졌으면(트레이 밖에서 종료 등) 이 프로세스가 이어받는다
    if (!running && !(external = await localInfo())) await startHere().catch((e) => console.error(e));
    buildMenu();
  }, 5000);

  if (!SILENT) showInfo();
}

app.whenReady().then(async () => {
  setupLog();
  const firstRun = ensureConfig();
  cfg = loadConfig(dataDir());
  if (SERVER_MODE) await runServerMode();
  else await runTrayMode(firstRun);
});
