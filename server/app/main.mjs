// 집 PC용 트레이 앱: 더블클릭 한 번으로 서버 실행, 방화벽 허용, 로그인 시 자동 실행까지 처리한다.
import { app, Tray, Menu, dialog, shell, clipboard, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { defaultConfig, loadConfig } from '../dist/config.js';
import { lanAddresses, startServer } from '../dist/server.js';

const APP_NAME = 'RemoteFileManager Server';
const RULE_NAME = 'RemoteFileManager Server';
const AUTOSTART_ARG = '--autostart';

app.setAppUserModelId('remotefilemanager.server');
if (!app.requestSingleInstanceLock()) app.quit();

const dataDir = () => app.getPath('userData');
const configFile = () => path.join(dataDir(), 'config.json');
const logFile = () => path.join(dataDir(), 'server.log');
// portable exe는 실행할 때마다 임시 폴더에 풀리므로, 자동 실행에는 원래 exe 경로를 등록한다
const launcherPath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

// 개발 실행(npm run app)에서는 방화벽 규칙·자동 실행 같은 시스템 설정을 건드리지 않는다
const touchSystem = app.isPackaged && !process.env.REMOTE_FILE_MANAGER_NO_SYSTEM;

let tray = null;
let running = null;
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
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      out.write(`[${new Date().toLocaleString()}] ${text}\n`);
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

// ───────────────────────── 방화벽 ─────────────────────────
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
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await powershell(
    `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit 1 }`,
  );
  return r.ok;
}

/** 이 exe가 허용 대역에서만 포트를 받도록 규칙을 둔다. 설정이 바뀌었을 때만 다시 만든다 */
async function ensureFirewall() {
  const sig = 'sig:' + crypto.createHash('sha1').update(JSON.stringify([process.execPath.toLowerCase(), cfg.port, cfg.allowedIps])).digest('hex').slice(0, 16);
  const cur = await powershell(`(Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue | Select-Object -First 1).Description`);
  if (cur.out === sig) return true;
  const remote = cfg.allowedIps.length ? `@(${cfg.allowedIps.map(psQuote).join(',')})` : "'Any'";
  const ok = await elevated(
    [
      `Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
      `New-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -Description ${psQuote(sig)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${Number(cfg.port)} -Program ${psQuote(process.execPath)} -RemoteAddress ${remote} -Profile Any | Out-Null`,
    ].join('\n'),
  );
  if (!ok) console.warn('[방화벽] 허용 규칙을 만들지 못했습니다 (관리자 권한 취소)');
  return ok;
}

async function removeFirewall() {
  return elevated(`Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
}

// ───────────────────────── 자동 실행 ─────────────────────────
const autostartEnabled = () => app.getLoginItemSettings({ path: launcherPath(), args: [AUTOSTART_ARG] }).openAtLogin;
function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: launcherPath(), args: [AUTOSTART_ARG] });
}

// ───────────────────────── 트레이 ─────────────────────────
/** WireGuard 연결 등으로 IP가 바뀌면 표시 주소도 갱신 */
const refreshAddresses = () => (cfg.host === '0.0.0.0' ? lanAddresses() : [cfg.host]).map((h) => `${h}:${cfg.port}`);

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: APP_NAME, body }).show();
}

function showInfo() {
  const lines = running.addresses.length ? running.addresses.join('\n') : '(네트워크 연결 없음)';
  dialog
    .showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: '원격 PC 서버가 실행 중입니다',
      detail: `노트북의 RemoteFileManager에서 아래 주소로 연결하세요.\n\n${lines}\n\n작업 표시줄 트레이 아이콘에서 관리할 수 있습니다.`,
      buttons: ['확인', '주소 복사'],
      defaultId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 1) clipboard.writeText(running.addresses[0] || '');
    });
}

let menuKey = '';
function buildMenu() {
  const n = running.terminals.list().length;
  const key = JSON.stringify([n, running.addresses, autostartEnabled()]);
  if (key === menuKey) return; // 바뀐 게 없으면 열려 있는 메뉴를 건드리지 않는다
  menuKey = key;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `실행 중 · 포트 ${cfg.port}${n ? ` · 터미널 ${n}개` : ''}`, enabled: false },
      ...running.addresses.map((a) => ({ label: `${a} 복사`, click: () => clipboard.writeText(a) })),
      { type: 'separator' },
      { label: '접속 정보 보기', click: showInfo },
      { label: 'Windows 시작 시 자동 실행', type: 'checkbox', checked: autostartEnabled(), click: (item) => {
          setAutostart(item.checked);
          buildMenu();
        } },
      { label: '설정 파일 열기', click: () => shell.openPath(configFile()) },
      { label: '로그 열기', click: () => shell.openPath(logFile()) },
      { label: '다시 시작', click: restart },
      { type: 'separator' },
      { label: '제거...', click: uninstall },
      { label: '종료', click: quit },
    ]),
  );
  tray.setToolTip(`${APP_NAME}\n${running.addresses.join('\n')}`);
}

function restart() {
  app.relaunch({ execPath: launcherPath(), args: [] });
  running?.close();
  app.exit(0);
}

async function quit() {
  const n = running.terminals.list().length;
  if (n) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '서버를 종료할까요?',
      detail: `실행 중인 터미널 ${n}개(Claude Code 포함)도 함께 종료되고, 노트북에서 이 PC에 연결할 수 없게 됩니다.`,
      buttons: ['종료', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
  }
  running.close();
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
  setAutostart(false);
  await removeFirewall();
  running.close();
  const dir = dataDir();
  // 로그 스트림이 열려 있어 바로 지울 수 없으므로 종료 직후 지운다
  execFile('cmd.exe', ['/c', `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${dir}"`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}

// ───────────────────────── 시작 ─────────────────────────
app.on('second-instance', () => running && showInfo());
app.on('window-all-closed', () => {
  /* 창 없이 트레이로 계속 실행 */
});

app.whenReady().then(async () => {
  setupLog();
  const firstRun = ensureConfig();
  cfg = loadConfig(dataDir());
  const silent = process.argv.includes(AUTOSTART_ARG);

  if (touchSystem && (firstRun || autostartEnabled())) setAutostart(true); // 이미 켜져 있으면 exe를 옮긴 경우를 위해 경로 갱신

  const fwOk = touchSystem ? await ensureFirewall() : true;
  try {
    running = await startServer(cfg);
  } catch (err) {
    console.error(err);
    dialog.showErrorBox(
      APP_NAME,
      err.code === 'EADDRINUSE' ? `포트 ${cfg.port}를 이미 다른 프로그램이 사용 중입니다.\n이미 서버가 실행 중인지 확인하세요.` : `서버를 시작하지 못했습니다.\n${err.message}`,
    );
    return app.exit(1);
  }
  console.log(`서버 실행: ${running.addresses.join(', ')} (허용 대역: ${cfg.allowedIps.join(', ') || '전체'})`);

  tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
  tray.on('click', () => tray.popUpContextMenu());
  buildMenu();
  tray.on('right-click', buildMenu);
  setInterval(() => {
    running.addresses = refreshAddresses();
    buildMenu();
  }, 5000);

  if (!fwOk) notify('방화벽 허용이 취소되어 노트북에서 접속하지 못할 수 있습니다. 트레이 메뉴의 다시 시작으로 다시 시도하세요.');
  if (!silent) showInfo();
});
