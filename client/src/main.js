const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme, clipboard, Notification, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const net = require('node:net');
const dns = require('node:dns/promises');
const { fileURLToPath } = require('node:url');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

app.setAppUserModelId('remotefilemanager.explorer');

// ───────────────────────── 설정 ─────────────────────────
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
// pcs: 등록된 PC [{ id, name, server, mac, named }] — named가 false면 연결할 때 원격 컴퓨터 이름으로 갱신
let settings = { server: '', pcs: [] };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    /* 첫 실행 */
  }
  // 이전 형식(최근 주소 목록 + WireWOL 정보 하나)을 PC 목록으로 옮긴다
  if (settings.recent) {
    for (const s of settings.recent) upsertPc(s);
    if (settings.wol?.mac) {
      const pc = settings.pcs.find((p) => hostOf(p.server) === settings.wol.host);
      if (pc) pc.mac = settings.wol.mac;
    }
    delete settings.recent;
    delete settings.wol;
    saveSettings();
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port) u.port = '7420';
  return `${u.protocol}//${u.host}`;
}
function hostOf(server) {
  try {
    return new URL(normalizeServer(server)).hostname;
  } catch {
    return '';
  }
}

function upsertPc(server, fields = {}) {
  let pc = settings.pcs.find((p) => p.server === server);
  if (!pc) {
    pc = { id: crypto.randomUUID(), name: server.replace(/^https?:\/\//, ''), server, mac: '', named: false };
    settings.pcs.push(pc);
  }
  Object.assign(pc, fields);
  return pc;
}

let remoteInfo = null;

// ───────────────────────── API 프록시 ─────────────────────────
async function api(method, apiPath, { query, body, server } = {}) {
  const base = server || settings.server;
  if (!base) return { ok: false, status: 0, data: { code: 'ENOSERVER', message: '연결된 PC가 없습니다' } };
  const url = new URL(apiPath, base);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' && apiPath.endsWith('/search') ? 15000 : 120000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { code: 'ENETWORK', message: `원격 PC에 연결할 수 없습니다 (${e.cause?.code || e.message})` } };
  }
}

ipcMain.handle('api', (_e, method, apiPath, opts) => api(method, apiPath, opts));

/** 노트북 탐색기의 보기 설정을 그대로 따른다 (확장명 / 숨김 항목 / 보호된 운영체제 파일) */
let explorerPrefs = null;
function readExplorerPrefs() {
  if (explorerPrefs) return Promise.resolve(explorerPrefs);
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'], { windowsHide: true }, (err, stdout) => {
      const val = (name, def) => {
        const m = new RegExp(`^\\s*${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'im').exec(stdout || '');
        return m ? parseInt(m[1], 16) : def;
      };
      explorerPrefs = {
        hideExt: val('HideFileExt', 1) === 1,
        showHidden: val('Hidden', 2) === 1,
        showSystem: val('ShowSuperHidden', 0) === 1,
      };
      resolve(explorerPrefs);
    });
  });
}

ipcMain.handle('connection:get', async () => ({
  server: settings.server,
  info: remoteInfo,
  explorer: await readExplorerPrefs(),
}));
ipcMain.handle('connection:connect', async (e, input) => {
  let server;
  try {
    server = normalizeServer(input);
  } catch {
    return { ok: false, message: '주소 형식이 올바르지 않습니다' };
  }
  const r = await api('GET', '/api/info', { server });
  if (!r.ok || r.data?.app !== 'remote-file-manager') return { ok: false, message: r.data?.message || '원격 PC 서버가 응답하지 않습니다' };
  const changed = settings.server !== server;
  settings.server = server;
  const pc = upsertPc(server);
  if (!pc.named) pc.name = r.data.hostname;
  saveSettings();
  remoteInfo = r.data;
  // 다른 PC로 바꾸면 열려 있던 다른 탐색기 창도 새 PC로 다시 연다 (터미널 창은 자기 PC에 그대로 붙어 있다)
  if (changed) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== e.sender && !terminalWindows.has(w.webContents.id)) w.loadFile(path.join(__dirname, 'explorer', 'explorer.html'));
    }
  }
  return { ok: true, server, info: remoteInfo };
});

// ───────────────────────── 등록된 PC ─────────────────────────
ipcMain.handle('pcs:list', () => settings.pcs);
ipcMain.handle('pcs:rename', (_e, id, name) => {
  const pc = settings.pcs.find((p) => p.id === id);
  const n = String(name || '').trim();
  if (!pc || !n) return false;
  Object.assign(pc, { name: n, named: true });
  saveSettings();
  return true;
});
ipcMain.handle('pcs:remove', (_e, id) => {
  settings.pcs = settings.pcs.filter((p) => p.id !== id);
  saveSettings();
  ww.updateSecrets((s) => delete s.pairings?.[id]);
});

// ───────────────────────── 실행 취소 / 다시 실행 기록 (모든 탐색기 창이 함께 쓴다) ─────────────────────────
const history = { undo: [], redo: [] };
const takeLast = (stack) => {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].server === settings.server) return stack.splice(i, 1)[0];
  return null;
};
const peekLast = (stack) => stack.findLast((op) => op.server === settings.server)?.type || null;
ipcMain.handle('history:push', (_e, op) => {
  history.undo.push({ ...op, server: settings.server });
  if (history.undo.length > 100) history.undo.shift();
  history.redo = history.redo.filter((o) => o.server !== settings.server);
});
ipcMain.handle('history:take', (_e, which) => takeLast(history[which]));
ipcMain.handle('history:put', (_e, which, op) => history[which].push(op));
ipcMain.handle('history:peek', () => ({ undo: peekLast(history.undo), redo: peekLast(history.redo) }));
ipcMain.handle('connection:info', async () => {
  const r = await api('GET', '/api/info');
  if (r.ok) remoteInfo = r.data;
  return r;
});

// ───────────────────────── WireWOL 내장 (와이어가드 / PC 켜기·끄기 / 설정 파일) ─────────────────────────
const ww = require('./wirewol');

const portOf = (server) => Number(new URL(normalizeServer(server)).port) || 7420;
const pairingOf = (pc) => ww.getSecrets().pairings?.[pc.id] || null;
const pcById = (id) => settings.pcs.find((p) => p.id === id);

// 와이어가드 상태: noconf | notinstalled | direct(PC에 바로 닿음) | starting | up | off(PC 종료를 확인해 끔) | error
// 집 밖이면 앱을 켤 때 켜서 끝낼 때까지 유지한다(WireWOL PC: 창을 닫아 앱을 끝낼 때만 끈다)
// routes: 지금 켜 둔 터널이 맡은 주소(AllowedIPs)를 이어 붙인 것
const tunnel = { state: 'checking', message: '', ours: false, routes: '', pending: null };

function tunnelStatus() {
  return { state: tunnel.state, message: tunnel.message, hasConf: !!ww.getSecrets().wireguardConf };
}
function setTunnel(state, message = '') {
  tunnel.state = state;
  tunnel.message = message;
  broadcast('tunnel:state', tunnelStatus());
}

/** 와이어가드 없이 등록된 PC(서버 또는 컴패니언 포트)에 바로 닿는지 — 집 안이거나 다른 VPN이 이미 연결됨 */
async function anyPcReachable() {
  const checks = settings.pcs.flatMap((pc) => {
    const p = pairingOf(pc);
    return [ww.tcpProbe(hostOf(pc.server), portOf(pc.server)), ...(p ? [ww.tcpProbe(p.host, p.port)] : [])];
  });
  return checks.length > 0 && (await Promise.all(checks)).some(Boolean);
}

const ipToInt = (ip) => ip.split('.').reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
const isPrivateIp = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/**
 * 내장 터널이 맡을 주소(AllowedIPs) — 등록된 PC(서버·컴패니언)의 사설 /24 대역(지정 브로드캐스트 WOL 포함).
 * 노트북이 이미 그 대역 안에 있는 PC는 뺀다: 집 안이면 바로 닿고, 우연히 같은 대역을 쓰는 다른 망이면
 * 터널로 보내 봐야 그 망의 기기와 충돌만 한다. 그래서 집 안에서는 PC가 꺼져 있어도 목록이 비어
 * 터널을 켜지 않는다. 대역이 노트북 망과 겹치면 PC 주소(/32)만 넣는다.
 */
async function tunnelRoutes() {
  const local = Object.entries(os.networkInterfaces())
    .filter(([name]) => name !== ww.TUNNEL_NAME)
    .flatMap(([, addrs]) => addrs.filter((a) => a.family === 'IPv4' && !a.internal))
    .map((a) => ({ addr: ipToInt(a.address), mask: ipToInt(a.netmask) }));
  const hosts = settings.pcs.flatMap((pc) => [hostOf(pc.server), pairingOf(pc)?.host].filter(Boolean));
  const ips = await Promise.all(
    hosts.map((h) => (net.isIPv4(h) ? h : dns.lookup(h, { family: 4 }).then((r) => r.address, () => null))),
  );
  const routes = new Set();
  for (const ip of ips) {
    if (!ip) continue;
    const n = ipToInt(ip);
    if (local.some((l) => ((n ^ l.addr) & l.mask) === 0)) continue;
    const net24 = (n & 0xffffff00) >>> 0;
    const overlaps = local.some((l) => ((l.addr & 0xffffff00) >>> 0) === net24);
    routes.add(isPrivateIp(ip) && !overlaps ? `${ip.replace(/\.\d+$/, '.0')}/24` : `${ip}/32`);
  }
  return [...routes].sort();
}

/**
 * 와이어가드 확보 — PC에 바로 닿거나 PC가 모두 노트북과 같은 망이면 켜지 않고, 아니면 내장 터널을 켠다.
 * 이미 켜진 터널도 지금 망에서 맡을 주소가 달라졌으면(망 이동, 이전 실행에서 남은 터널) 끄고 다시 판단한다.
 */
function ensureTunnel() {
  tunnel.pending ??= (async () => {
    const conf = ww.getSecrets().wireguardConf;
    if (!conf) return setTunnel('noconf');
    const routes = await tunnelRoutes();
    if ((await ww.serviceState()) === 'running') {
      if (tunnel.ours && tunnel.routes === routes.join()) return setTunnel('up');
      await ww.tunnelDown().catch(() => {});
      tunnel.ours = false;
    }
    if (!routes.length || (await anyPcReachable())) return setTunnel('direct');
    if (!ww.runtimeBundled()) return setTunnel('error', '이 빌드에는 내장 WireGuard 파일이 들어 있지 않습니다');
    if (!(await ww.tunnelInstalled())) return setTunnel('notinstalled');
    setTunnel('starting');
    try {
      await ww.tunnelUp(conf, routes);
      tunnel.ours = true;
      tunnel.routes = routes.join();
      setTunnel('up');
      // 터널을 올린 직후엔 라우팅·핸드셰이크가 끝나지 않았을 수 있어 3초짜리 연결 시도로 자리 잡을 시간을 번다
      const pc = settings.pcs.find((p) => p.server === settings.server) || settings.pcs[0];
      if (pc) await ww.tcpProbe(hostOf(pc.server), portOf(pc.server), 3000);
    } catch (e) {
      setTunnel('error', e.message);
    }
  })().finally(() => (tunnel.pending = null));
  return tunnel.pending;
}

/** 설정이 바뀌면 켜져 있던 터널을 새 설정으로 다시 띄운다 */
async function restartTunnel() {
  if (tunnel.ours) {
    await ww.tunnelDown().catch(() => {});
    tunnel.ours = false;
  }
  await ensureTunnel();
}

// 켜 둔 터널이 서비스 오류 등으로 내려가면 다시 올리고, 망이 바뀌어(예: 집에 들어옴) 맡을 주소가
// 달라지면 다시 판단한다 — 집 안에서는 터널이 꺼진다
setInterval(async () => {
  if (!tunnel.ours || tunnel.pending || quitting) return;
  if ((await ww.serviceState()) === 'running') {
    if ((await tunnelRoutes()).join() !== tunnel.routes) ensureTunnel();
    return;
  }
  tunnel.ours = false;
  ensureTunnel();
}, 15000);

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !tunnel.ours) return;
  e.preventDefault();
  quitting = true;
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  ww.tunnelDown()
    .catch(() => {})
    .finally(() => app.quit());
});

ipcMain.handle('tunnel:get', () => tunnelStatus());
// 사용자가 직접 켜면 그 선택이 우선 — 남은 "종료 확인 후 끄기"가 나중에 터널을 끊지 않게 한다
ipcMain.handle('tunnel:ensure', () => {
  clearWgOffWatch();
  return ensureTunnel().then(tunnelStatus);
});
ipcMain.handle('tunnel:install', async () => {
  setTunnel('starting', '내장 WireGuard 설치 중...');
  const r = await ww.installTunnel();
  if (!r.ok) {
    setTunnel(r.cancelled ? 'notinstalled' : 'error', r.cancelled ? '' : r.message);
    return r;
  }
  await ensureTunnel();
  return { ok: true };
});

// ── PC 상태 ──
const shutdownAtByPc = new Map(); // 컴패니언으로 예약한 종료 시각 (서버는 자기 예약을 /api/info로 알려준다)

async function probeServer(server, timeout = 3000) {
  try {
    const res = await fetch(new URL('/api/info', server), { signal: AbortSignal.timeout(timeout) });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.app === 'remote-file-manager') return { ok: true, hostname: data.hostname, shutdownAt: data.shutdownAt || 0 };
    return { ok: false, message: data?.message || `응답 오류 (${res.status})` };
  } catch {
    return { ok: false };
  }
}

/** 서버가 응답하면 켜짐, 서버는 없지만 컴패니언이 응답하면 "켜짐 · 서버 꺼짐" */
ipcMain.handle('pcs:status', async (_e, id) => {
  const pc = pcById(id);
  if (!pc) return null;
  const server = await probeServer(pc.server);
  if (server.ok && !pc.named && pc.name !== server.hostname) {
    pc.name = server.hostname;
    saveSettings();
  }
  const pairing = pairingOf(pc);
  let companion = null;
  if (!server.ok && pairing) companion = await ww.companionPing(pairing, 3000).then(() => true, () => false);
  const local = shutdownAtByPc.get(id) || 0;
  const shutdownAt = Math.max(server.shutdownAt || 0, local > Date.now() ? local : 0);
  return { server, companion, shutdownAt, name: pc.name, tunnel: tunnel.state };
});

/** 서버나 컴패니언 중 하나라도 응답하면 켜진 것 */
async function pcResponds(pc, timeout = 3000) {
  if ((await probeServer(pc.server, timeout)).ok) return true;
  const pairing = pairingOf(pc);
  return !!pairing && (await ww.companionPing(pairing, timeout).then(() => true, () => false));
}

/** 노트북 자체가 네트워크에 붙어 있는지 — 끊겼다면 PC 무응답은 PC가 꺼졌다는 근거가 아니다 */
const hasAnyNetwork = () =>
  Object.entries(os.networkInterfaces()).some(
    ([name, addrs]) => name !== ww.TUNNEL_NAME && addrs.some((a) => a.family === 'IPv4' && !a.internal),
  );

/** 매직 패킷(집 안: 브로드캐스트, 집 밖: 터널로 지정 브로드캐스트·PC 주소) + 설정돼 있으면 공유기 원격 WOL */
async function sendWake(pc) {
  await ww.sendMagicPacket(pc.mac, hostOf(pc.server)).catch(() => {});
  try {
    return (await ww.routerWake(pc.mac)) ? '공유기를 통해서도 깨우기 신호를 보냈습니다' : '';
  } catch (e) {
    return `원격 WOL 실패: ${e.message}`;
  }
}

// ── 종료 확인 후 와이어가드 끄기 ── (WireWOL PC의 _arm_wireguard_off_watch와 같음)
// 예약 시각 전엔 PC가 켜져 있는 게 정상이고(취소 요청이 터널로 나가야 한다), 시각이 됐다고 바로 끄면
// PC 쪽에서 종료가 취소·실패해도 터널이 끊긴다 — 예약 시각부터 5초마다 확인해 무응답일 때만 끈다.
// 10분 안에 꺼지지 않으면 그만둔다. 터널을 함께 쓰는 다른 PC가 응답하면 끄지 않는다.
const WG_OFF_WATCH_INTERVAL_MS = 5000;
const WG_OFF_WATCH_TIMEOUT_MS = 10 * 60 * 1000;
const wgOffWatch = { pcId: null, from: 0, timer: null, gen: 0 };

function clearWgOffWatch() {
  clearTimeout(wgOffWatch.timer);
  wgOffWatch.pcId = null;
  wgOffWatch.gen++;
}
function armWgOffWatch(pcId, at) {
  clearWgOffWatch();
  if (!tunnel.ours) return;
  wgOffWatch.pcId = pcId;
  wgOffWatch.from = at;
  wgOffWatch.timer = setTimeout(wgOffWatchTick, Math.max(0, at - Date.now()));
}
async function wgOffWatchTick() {
  const gen = wgOffWatch.gen;
  const pc = pcById(wgOffWatch.pcId);
  if (!pc || !tunnel.ours || Date.now() - wgOffWatch.from > WG_OFF_WATCH_TIMEOUT_MS) return clearWgOffWatch();
  const again = () => {
    if (gen === wgOffWatch.gen) wgOffWatch.timer = setTimeout(wgOffWatchTick, WG_OFF_WATCH_INTERVAL_MS);
  };
  if (!hasAnyNetwork() || tunnel.pending || (await pcResponds(pc))) return again();
  if (gen !== wgOffWatch.gen) return; // 그사이 해제·재설정됨
  clearWgOffWatch();
  const others = settings.pcs.filter((p) => p.id !== pc.id);
  if ((await Promise.all(others.map((p) => pcResponds(p, 1500)))).some(Boolean)) return;
  if (!tunnel.ours || tunnel.pending) return;
  await ww.tunnelDown().catch(() => {});
  tunnel.ours = false;
  setTunnel('off');
}

// ── PC 켜기 ── (WireWOL PC의 _on_power_on_clicked와 같은 순서)
ipcMain.handle('pcs:wake', async (_e, id) => {
  const pc = pcById(id);
  if (!pc?.mac || !ww.parseMac(pc.mac)) return { ok: false, message: 'MAC 주소가 없습니다 — PC 메뉴의 WireWOL 연결 정보에서 입력하세요' };
  // 다시 켜려는 참이니 이전 종료의 "확인 후 와이어가드 끄기"가 켜는 도중 터널을 끊지 않게 한다
  clearWgOffWatch();
  // 터널을 켜기 전에 한 번 보낸다 — 터널이 켜진 뒤엔 255.255.255.255가 집 LAN에 닿지 않는 경우가 있다
  await ww.sendMagicPacket(pc.mac, hostOf(pc.server)).catch(() => {});
  await ensureTunnel();
  return { ok: true, note: await sendWake(pc) };
});

// ── PC 끄기 / 예약 / 취소 ── 서버가 처리하고, 서버가 응답하지 않으면 WireWOL 컴패니언으로 보낸다
const WAKE_RETRY_TIMEOUT_MS = 30000;

async function sendShutdown(pc, delaySeconds) {
  const r = await api('POST', '/api/power/shutdown', { server: pc.server, body: { delaySeconds } });
  if (r.ok) return { ok: true, shutdownAt: r.data.shutdownAt };
  const pairing = pairingOf(pc);
  if (!pairing) return { ok: false, message: r.data?.message || 'PC가 응답하지 않습니다' };
  try {
    await ww.companionShutdown(pairing, delaySeconds);
    const at = Date.now() + (delaySeconds ?? 10) * 1000;
    shutdownAtByPc.set(pc.id, at);
    return { ok: true, shutdownAt: at, via: 'companion' };
  } catch (e) {
    return { ok: false, message: `종료 요청 실패: ${e.message}` };
  }
}

// WireWOL PC의 _request_shutdown과 같은 순서: 연결 확보(집 밖이면 와이어가드) → 종료 요청 →
// 응답이 없으면(절전이면 서버·컴패니언이 멈춰 있다) 깨우고 1초마다 확인하다 응답하는 즉시 한 번만 다시 요청
ipcMain.handle('pcs:shutdown', async (_e, id, delaySeconds) => {
  const pc = pcById(id);
  if (!pc) return { ok: false, message: 'PC를 찾을 수 없습니다' };
  await ensureTunnel();
  let r = await sendShutdown(pc, delaySeconds);
  if (!r.ok && pc.mac && ww.parseMac(pc.mac)) {
    await sendWake(pc);
    const until = Date.now() + WAKE_RETRY_TIMEOUT_MS;
    let woke = false;
    while (!woke && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 1000));
      woke = await pcResponds(pc, 1500);
    }
    r = woke
      ? await sendShutdown(pc, delaySeconds)
      : { ok: false, message: 'PC가 응답하지 않아 종료할 수 없습니다(절전 상태에서 깨우기에 실패했을 수 있습니다)' };
  }
  if (r.ok) armWgOffWatch(id, r.shutdownAt);
  return r;
});
ipcMain.handle('pcs:cancelShutdown', async (_e, id) => {
  const pc = pcById(id);
  if (!pc) return { ok: false };
  const r = await api('POST', '/api/power/cancel', { server: pc.server, body: {} });
  const pairing = pairingOf(pc);
  let companionOk = false;
  if (pairing && (!r.ok || shutdownAtByPc.has(id))) companionOk = await ww.companionCancel(pairing).then(() => true, () => false);
  shutdownAtByPc.delete(id);
  if (!(r.ok || companionOk)) return { ok: false, message: r.data?.message || '취소 요청 실패' };
  if (wgOffWatch.pcId === id) clearWgOffWatch();
  return { ok: true };
});
const currentPcId = () => settings.pcs.find((p) => p.server === settings.server)?.id;
ipcMain.handle('pcs:current', () => currentPcId() || null);

// ── PC별 WireWOL 연결 정보 (컴패니언 주소·포트·토큰, MAC) ──
ipcMain.handle('pcs:getPairing', (_e, id) => {
  const pc = pcById(id);
  if (!pc) return null;
  const p = pairingOf(pc) || {};
  return { host: p.host || hostOf(pc.server), port: p.port || '', token: p.token || '', mac: pc.mac || '' };
});
ipcMain.handle('pcs:setPairing', (_e, id, v) => {
  const pc = pcById(id);
  if (!pc) return { ok: false, message: 'PC를 찾을 수 없습니다' };
  const mac = String(v.mac || '').trim();
  if (mac && !ww.parseMac(mac)) return { ok: false, message: 'MAC 주소 형식이 올바르지 않습니다 (예: AA-BB-CC-DD-EE-FF)' };
  const host = String(v.host || '').trim();
  const port = String(v.port || '').trim();
  const token = String(v.token || '').trim();
  if ((port || token) && !(host && /^\d+$/.test(port) && token)) return { ok: false, message: '컴패니언을 쓰려면 주소, 포트(숫자), 토큰을 모두 입력하세요' };
  pc.mac = mac;
  saveSettings();
  ww.updateSecrets((s) => {
    s.pairings = { ...s.pairings };
    if (port && token) s.pairings[id] = { host, port, token };
    else delete s.pairings[id];
  });
  return { ok: true };
});

// ── 공통 WireWOL 설정 (WireGuard / 공유기 원격 WOL) ──
ipcMain.handle('ww:get', () => {
  const s = ww.getSecrets();
  const r = s.routerWol;
  return { tunnel: tunnelStatus(), router: r ? { host: r.host, port: r.port, id: r.id } : null };
});
ipcMain.handle('ww:importConf', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'WireGuard 설정 파일 불러오기',
    filters: [{ name: 'WireGuard 설정', extensions: ['conf'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const text = await fsp.readFile(filePaths[0], 'utf8').catch(() => '');
  if (!/\[Interface\]/i.test(text) || !/PrivateKey\s*=/i.test(text) || !/\[Peer\]/i.test(text)) return { ok: false, message: 'WireGuard 설정 파일이 아닙니다' };
  ww.updateSecrets((s) => (s.wireguardConf = text.replace(/^﻿/, '')));
  restartTunnel();
  return { ok: true };
});
ipcMain.handle('ww:clearConf', async () => {
  if (tunnel.ours) await ww.tunnelDown().catch(() => {});
  tunnel.ours = false;
  ww.updateSecrets((s) => delete s.wireguardConf);
  await ensureTunnel();
  return { ok: true };
});
ipcMain.handle('ww:setRouter', (_e, r) => {
  const host = String(r?.host || '').trim();
  const port = String(r?.port || '443').trim();
  const id = String(r?.id || '').trim();
  const old = ww.getSecrets().routerWol;
  const password = String(r?.password || '') || (old && old.host === host && old.id === id ? old.password : '');
  if (!host || !/^\d+$/.test(port) || !id || !password) return { ok: false, message: '공유기 주소, 포트, 아이디, 비밀번호를 모두 입력하세요' };
  // 인증서 지문은 새로 저장할 때 다시 받는다(공유기 교체 대응)
  ww.updateSecrets((s) => {
    s.routerWol = { host, port, id, password };
    if (s.routerCertFp) delete s.routerCertFp[host];
  });
  return { ok: true };
});
ipcMain.handle('ww:clearRouter', () => {
  ww.updateSecrets((s) => {
    delete s.routerWol;
    delete s.routerCertFp;
  });
  return { ok: true };
});

// ── 설정 파일 (wirewol_settings.json) 내보내기 / 불러오기 — WireWOL(안드로이드/PC)과 같은 형식 ──
ipcMain.handle('wirewol:pick', async (e) => {
  const desktop = path.join(app.getPath('desktop'), ww.BACKUP_FILE);
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'WireWOL 설정 파일 불러오기',
    defaultPath: fs.existsSync(desktop) ? desktop : app.getPath('desktop'),
    filters: [{ name: 'WireWOL 설정 파일', extensions: ['json'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('wirewol:check', (_e, file) =>
  ww.readBackupEnvelope(file) ? { ok: true, name: path.basename(file) } : { ok: false, message: 'WireWOL 설정 파일이 아닙니다' },
);

/** 불러오면 WireGuard·공유기 설정은 파일 것으로 바뀌고, 파일의 PC는 목록에 추가(또는 갱신)된다 */
ipcMain.handle('wirewol:import', async (_e, file, password) => {
  const r = await ww.decryptBackup(file, password);
  if (!r.ok) return r;
  const { pairing, wireguardConf, routerWol, autoShutdown } = r.contents;
  let host = '';
  if (pairing) {
    host = pairing.host.trim();
    let server;
    try {
      server = normalizeServer(host);
    } catch {
      return { ok: false, message: `설정 파일의 PC 주소가 올바르지 않습니다 (${host})` };
    }
    // PC가 꺼져 있어도 목록에서 켤 수 있게 연결 전에 등록해 둔다
    const pc = upsertPc(server, ww.parseMac(pairing.mac) ? { mac: pairing.mac.trim() } : {});
    saveSettings();
    ww.updateSecrets((s) => (s.pairings = { ...s.pairings, [pc.id]: { host, port: pairing.port, token: pairing.token } }));
  }
  const confChanged = (wireguardConf || null) !== (ww.getSecrets().wireguardConf || null);
  ww.updateSecrets((s) => {
    if (wireguardConf) s.wireguardConf = wireguardConf;
    else delete s.wireguardConf;
    if (routerWol) s.routerWol = routerWol;
    else delete s.routerWol;
    delete s.routerCertFp;
    s.autoShutdown = autoShutdown;
  });
  if (confChanged) await restartTunnel();
  else await ensureTunnel();
  return { ok: true, host };
});

ipcMain.handle('wirewol:export', async (e, pcId, password) => {
  if (String(password || '').length < 4) return { ok: false, message: '비밀번호는 4자 이상으로 정하세요' };
  const s = ww.getSecrets();
  const pc = pcById(pcId);
  const p = pc && pairingOf(pc);
  const contents = {
    pairing: p ? { host: p.host, port: String(p.port), token: p.token, mac: pc.mac || '' } : null,
    wireguard_conf: s.wireguardConf || null,
    router_wol: s.routerWol ? { ...s.routerWol } : null,
    auto_shutdown: s.autoShutdown || { enabled: false, delay_minutes: 60 },
  };
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'WireWOL 설정 내보내기',
    defaultPath: path.join(app.getPath('desktop'), ww.BACKUP_FILE),
    filters: [{ name: 'WireWOL 설정 파일', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  await fsp.writeFile(filePath, await ww.encryptBackup(contents, password));
  return { ok: true, file: filePath, withPairing: !!p };
});

// ───────────────────────── 아이콘 (노트북의 실제 Windows 셸 아이콘) ─────────────────────────
const iconCacheFile = () => path.join(app.getPath('userData'), 'icon-cache.json');
let iconCache = null; // key -> { s, l } (base64 png)
let iconQueue = new Map(); // key -> [resolve]
let iconTimer = null;

function loadIconCache() {
  if (iconCache) return;
  try {
    iconCache = JSON.parse(fs.readFileSync(iconCacheFile(), 'utf8'));
  } catch {
    iconCache = {};
  }
}

function iconRequest(key) {
  if (key === 'folder') return { key, path: 'folder', attr: true, dir: true };
  if (key.startsWith('drive:')) return { key, path: `${process.env.SystemDrive || 'C:'}\\` };
  if (key.startsWith('known:')) {
    let p;
    try {
      p = app.getPath(key.slice(6));
    } catch {
      p = os.homedir();
    }
    return { key, path: p };
  }
  const ext = key.replace(/[^\w.-]/g, '');
  return { key, path: ext ? `file.${ext}` : 'file', attr: true };
}

function flushIcons() {
  iconTimer = null;
  const batch = iconQueue;
  iconQueue = new Map();
  const reqs = [...batch.keys()].map(iconRequest);
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'shell-icons.ps1').replace('app.asar', 'app.asar.unpacked')],
    { env: { ...process.env, RD_ICONS: JSON.stringify(reqs) }, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout) => {
      let result = {};
      if (!err) {
        try {
          result = JSON.parse(stdout) || {};
        } catch {
          /* 무시 */
        }
      }
      for (const [k, v] of Object.entries(result)) if (v && v.s) iconCache[k] = v;
      if (Object.keys(result).length) fs.promises.writeFile(iconCacheFile(), JSON.stringify(iconCache)).catch(() => {});
      for (const [k, waiters] of batch) for (const w of waiters) w(iconCache[k] || null);
    },
  );
}

ipcMain.handle('icon', async (_e, key, size) => {
  loadIconCache();
  const pick = (v) => (v ? `data:image/png;base64,${size === 'small' ? v.s : v.l || v.s}` : null);
  if (iconCache[key]) return pick(iconCache[key]);
  const v = await new Promise((resolve) => {
    if (!iconQueue.has(key)) iconQueue.set(key, []);
    iconQueue.get(key).push(resolve);
    if (!iconTimer) iconTimer = setTimeout(flushIcons, 30);
  });
  return pick(v);
});

// ───────────────────────── 파일 열기 (내려받아 노트북 기본 앱으로 열고, 저장하면 다시 올림) ─────────────────────────
const cacheRoot = () => path.join(app.getPath('temp'), 'RemoteFileManager', 'open');
const watchers = new Map(); // localDir -> { watcher, files: Map<name, {remote, lastSig, timer}> }

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

async function downloadTo(remotePath, localPath, onProgress) {
  const url = new URL('/api/fs/download', settings.server);
  url.searchParams.set('path', remotePath);
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `내려받기 실패 (${res.status})`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    done += c.length;
    onProgress?.(done, total);
  });
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  await pipeline(body, fs.createWriteStream(localPath));
}

async function uploadFrom(localPath, remotePath, overwrite) {
  const url = new URL('/api/fs/upload', settings.server);
  url.searchParams.set('path', remotePath);
  if (overwrite) url.searchParams.set('overwrite', '1');
  const st = await fsp.stat(localPath);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(st.size) },
    body: Readable.toWeb(fs.createReadStream(localPath)),
    duplex: 'half',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `올리기 실패 (${res.status})`), { status: res.status });
  return data;
}

function sigOf(p) {
  try {
    const st = fs.statSync(p);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function watchForSave(localPath, remotePath) {
  const dir = path.dirname(localPath);
  const name = path.basename(localPath);
  let w = watchers.get(dir);
  if (!w) {
    w = { files: new Map(), watcher: null };
    w.watcher = fs.watch(dir, (_ev, fname) => {
      const f = fname && w.files.get(fname);
      if (!f) return;
      clearTimeout(f.timer);
      f.timer = setTimeout(async () => {
        const full = path.join(dir, fname);
        const sig = sigOf(full);
        if (!sig || sig === f.lastSig) return;
        f.lastSig = sig;
        try {
          await uploadFrom(full, f.remote, true);
          broadcast('toast', { kind: 'ok', text: `${fname} — 원격 PC에 저장됨` });
          broadcast('fs:changed', { dir: remoteDirname(f.remote) });
        } catch (e) {
          broadcast('toast', { kind: 'error', text: `${fname} 저장 실패: ${e.message}` });
        }
      }, 700);
    });
    watchers.set(dir, w);
  }
  w.files.set(name, { remote: remotePath, lastSig: sigOf(localPath), timer: null });
}

function remoteDirname(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i <= 2 ? p.slice(0, 3) : p.slice(0, i);
}
function remoteBasename(p) {
  return p.split(/[\\/]/).filter(Boolean).pop();
}
function remoteJoin(dir, name) {
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : `${dir}\\${name}`;
}

const NOT_OPENABLE = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'lnk', 'scr', 'ps1', 'vbs', 'sys', 'dll']);

ipcMain.handle('file:open', async (e, remotePath) => {
  const name = remoteBasename(remotePath);
  const ext = path.extname(name).slice(1).toLowerCase();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (NOT_OPENABLE.has(ext)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: name,
      message: `${name}은(는) 원격 PC에서 실행해야 하는 파일입니다.`,
      detail: '이 위치에서 터미널을 열어 실행할 수 있습니다.',
      buttons: ['터미널에서 열기', '취소'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) openTerminal({ kind: 'shell', cwd: remoteDirname(remotePath) });
    return { ok: false };
  }
  const hash = crypto.createHash('sha1').update(`${settings.server}|${remoteDirname(remotePath).toLowerCase()}`).digest('hex').slice(0, 12);
  const localPath = path.join(cacheRoot(), hash, name);
  try {
    broadcast('progress', { id: remotePath, text: `${name} 여는 중...`, value: 0 });
    await downloadTo(remotePath, localPath, (d, t) =>
      broadcast('progress', { id: remotePath, text: `${name} 여는 중...`, value: t ? d / t : 0 }),
    );
  } catch (err) {
    broadcast('progress', { id: remotePath, done: true });
    dialog.showMessageBox(win, { type: 'error', title: name, message: err.message });
    return { ok: false };
  }
  broadcast('progress', { id: remotePath, done: true });
  watchForSave(localPath, remotePath);
  const err = await shell.openPath(localPath);
  if (err) dialog.showMessageBox(win, { type: 'error', title: name, message: err });
  return { ok: !err };
});

// ───────────────────────── 노트북 ↔ 원격 전송 ─────────────────────────
async function walkLocal(p) {
  const st = await fsp.stat(p);
  if (!st.isDirectory()) return [{ rel: path.basename(p), full: p, dir: false, size: st.size }];
  const out = [{ rel: path.basename(p), full: p, dir: true, size: 0 }];
  const stack = [[p, path.basename(p)]];
  while (stack.length) {
    const [abs, rel] = stack.pop();
    for (const d of await fsp.readdir(abs, { withFileTypes: true })) {
      const a = path.join(abs, d.name);
      const r = `${rel}\\${d.name}`;
      if (d.isDirectory()) {
        out.push({ rel: r, full: a, dir: true, size: 0 });
        stack.push([a, r]);
      } else if (d.isFile()) {
        out.push({ rel: r, full: a, dir: false, size: (await fsp.stat(a)).size });
      }
    }
  }
  return out;
}

async function askConflict(win, names) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '파일 바꾸기 또는 건너뛰기',
    message: `대상에 이름이 같은 항목이 ${names.length}개 있습니다.`,
    detail: names.slice(0, 6).join('\n') + (names.length > 6 ? `\n외 ${names.length - 6}개` : ''),
    buttons: ['대상 파일 덮어쓰기', '이 파일 건너뛰기', '둘 다 유지', '취소'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  });
  return ['overwrite', 'skip', 'rename', null][response];
}
ipcMain.handle('ask:conflict', (e, names) => askConflict(BrowserWindow.fromWebContents(e.sender), names));

/** 노트북 파일/폴더를 원격 폴더로 올리기 */
async function uploadLocalPaths(win, localPaths, remoteDir) {
  const tops = localPaths.map((p) => path.basename(p));
  const listing = await api('GET', '/api/fs/list', { query: { path: remoteDir } });
  const existing = new Set((listing.data?.entries || []).map((e) => e.name.toLowerCase()));
  const conflicts = tops.filter((n) => existing.has(n.toLowerCase()));
  let mode = 'overwrite';
  if (conflicts.length) {
    mode = await askConflict(win, conflicts);
    if (!mode) return { ok: false };
  }
  const items = [];
  for (const p of localPaths) {
    let base = path.basename(p);
    if (existing.has(base.toLowerCase())) {
      if (mode === 'skip') continue;
      if (mode === 'rename') {
        const ext = path.extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        let i = 1;
        let cand;
        do cand = `${stem} - 복사본${i > 1 ? ` (${i})` : ''}${ext}`;
        while (existing.has(cand.toLowerCase()) && ++i);
        base = cand;
      }
    }
    for (const it of await walkLocal(p)) items.push({ ...it, rel: base + it.rel.slice(path.basename(p).length) });
  }
  const total = items.reduce((a, b) => a + b.size, 0) || 1;
  let done = 0;
  const id = `upload-${Date.now()}`;
  try {
    for (const it of items) {
      const remote = remoteJoin(remoteDir, it.rel);
      if (it.dir) {
        const r = await api('POST', '/api/fs/mkdirp', { body: { path: remote } });
        if (!r.ok) throw new Error(r.data?.message);
        continue;
      }
      broadcast('progress', { id, text: `원격 PC로 복사 중: ${path.basename(it.full)}`, value: done / total });
      await uploadFrom(it.full, remote, true);
      done += it.size;
    }
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', title: '복사 실패', message: e.message });
  } finally {
    broadcast('progress', { id, done: true });
    broadcast('fs:changed', { dir: remoteDir });
  }
  return { ok: true };
}

ipcMain.handle('upload:paths', (e, localPaths, remoteDir) =>
  uploadLocalPaths(BrowserWindow.fromWebContents(e.sender), localPaths, remoteDir),
);

/** 노트북 클립보드에 복사된 파일(탐색기에서 Ctrl+C) 경로 */
async function clipboardType(mime) {
  for (const item of await clipboard.read().catch(() => [])) {
    if (item.types.includes(mime)) return item.getType(mime).catch(() => null);
  }
  return null;
}
async function clipboardFilePaths() {
  const blob = await clipboardType('text/uri-list');
  if (!blob) return [];
  return (await blob.text())
    .split(/\r?\n/)
    .filter((u) => u.startsWith('file:'))
    .map((u) => {
      try {
        return fileURLToPath(u);
      } catch {
        return null;
      }
    })
    .filter((p) => p && fs.existsSync(p));
}
async function clipboardPng() {
  const blob = await clipboardType('image/png');
  return blob ? Buffer.from(await blob.arrayBuffer()) : null;
}
ipcMain.handle('clipboard:files', () => clipboardFilePaths());
ipcMain.handle('clipboard:readText', () => clipboard.readText());
ipcMain.handle('clipboard:writeText', (_e, text) => clipboard.writeText(text));

/** 원격 파일/폴더를 노트북으로 내려받기 */
ipcMain.handle('download:paths', async (e, entries) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '내 노트북에 저장할 위치 선택',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '여기에 저장',
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const target = filePaths[0];
  const files = [];
  const walk = async (remote, localBase) => {
    const r = await api('GET', '/api/fs/list', { query: { path: remote } });
    if (!r.ok) throw new Error(r.data?.message);
    await fsp.mkdir(localBase, { recursive: true });
    for (const ent of r.data.entries) {
      if (ent.type === 'dir') await walk(ent.path, path.join(localBase, ent.name));
      else if (ent.type === 'file') files.push({ remote: ent.path, local: path.join(localBase, ent.name), size: ent.size });
    }
  };
  const id = `download-${Date.now()}`;
  try {
    for (const ent of entries) {
      if (ent.type === 'dir') await walk(ent.path, path.join(target, ent.name));
      else files.push({ remote: ent.path, local: path.join(target, ent.name), size: ent.size });
    }
    const total = files.reduce((a, b) => a + b.size, 0) || 1;
    let done = 0;
    for (const f of files) {
      await downloadTo(f.remote, f.local, (d) =>
        broadcast('progress', { id, text: `내 노트북으로 복사 중: ${path.basename(f.local)}`, value: (done + d) / total }),
      );
      done += f.size;
    }
  } catch (err) {
    dialog.showMessageBox(win, { type: 'error', title: '복사 실패', message: err.message });
    return { ok: false };
  } finally {
    broadcast('progress', { id, done: true });
  }
  if (Notification.isSupported()) {
    const n = new Notification({ title: '복사 완료', body: `${files.length}개 파일을 ${target}에 저장했습니다` });
    n.on('click', () => shell.openPath(target));
    n.show();
  }
  return { ok: true, target };
});

/** 클립보드 이미지/드롭된 파일을 원격 임시 폴더에 올리고 원격 경로 반환 (터미널용) */
ipcMain.handle('terminal:stage', async (_e, payload) => {
  const info = remoteInfo || (await api('GET', '/api/info')).data;
  const dir = `${info.home}\\.remote-file-manager\\inbox`;
  await api('POST', '/api/fs/mkdirp', { body: { path: dir } });
  const out = [];
  if (payload.image) {
    const png = await clipboardPng();
    if (!png) return [];
    const tmp = path.join(app.getPath('temp'), 'RemoteFileManager', `paste-${Date.now()}.png`);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    await fsp.writeFile(tmp, png);
    const remote = `${dir}\\${path.basename(tmp)}`;
    await uploadFrom(tmp, remote, true);
    out.push(remote);
  }
  for (const p of payload.paths || []) {
    const st = await fsp.stat(p);
    if (!st.isFile()) continue;
    const remote = `${dir}\\${Date.now()}-${path.basename(p)}`;
    await uploadFrom(p, remote, true);
    out.push(remote);
  }
  return out;
});
ipcMain.handle('clipboard:hasImage', () => clipboard.has('image/png').catch(() => false));

// ───────────────────────── 네이티브 컨텍스트 메뉴 / 대화상자 ─────────────────────────
ipcMain.handle('menu:popup', (e, template) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return new Promise((resolve) => {
    let chosen = null;
    const build = (items) =>
      items.map((it) =>
        it.type === 'separator'
          ? { type: 'separator' }
          : {
              label: it.label,
              accelerator: it.accelerator,
              registerAccelerator: false,
              enabled: it.enabled !== false,
              type: it.checked !== undefined ? 'checkbox' : 'normal',
              checked: it.checked,
              submenu: it.submenu ? build(it.submenu) : undefined,
              click: it.submenu ? undefined : () => (chosen = it.id),
            },
      );
    Menu.buildFromTemplate(build(template)).popup({ window: win, callback: () => setImmediate(() => resolve(chosen)) });
  });
});

ipcMain.handle('dialog:message', (e, opts) => dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), opts));

// ───────────────────────── 창 ─────────────────────────
function themeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#00000000', symbolColor: '#ffffff' }
    : { color: '#00000000', symbolColor: '#1a1a1a' };
}

function createExplorer(startPath, { home = false } = {}) {
  const win = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 520,
    minHeight: 360,
    show: false,
    title: '파일 탐색기',
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...themeColors(), height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'explorer', 'explorer.html'), {
    query: { ...(startPath ? { path: startPath } : {}), ...(home ? { home: '1' } : {}) },
  });
  win.once('ready-to-show', () => win.show());
  folderIcon().then((img) => img && !win.isDestroyed() && win.setIcon(img));
  return win;
}

let folderIconImage = null;
async function folderIcon() {
  if (folderIconImage) return folderIconImage;
  loadIconCache();
  const v =
    iconCache.folder ||
    (await new Promise((resolve) => {
      if (!iconQueue.has('folder')) iconQueue.set('folder', []);
      iconQueue.get('folder').push(resolve);
      if (!iconTimer) iconTimer = setTimeout(flushIcons, 30);
    }));
  if (v) folderIconImage = nativeImage.createFromBuffer(Buffer.from(v.l || v.s, 'base64'));
  return folderIconImage;
}

const terminalWindows = new Map(); // webContents.id -> sessionId

async function openTerminal({ kind, cwd, sessionId }) {
  let id = sessionId;
  if (!id) {
    const r = await api('POST', '/api/terminals', { body: { kind, cwd, cols: 120, rows: 32 } });
    if (!r.ok) {
      dialog.showMessageBox({ type: 'error', title: '터미널', message: r.data?.message || '터미널을 열 수 없습니다' });
      return null;
    }
    id = r.data.id;
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 400,
    minHeight: 240,
    show: false,
    title: kind === 'shell' ? 'Windows PowerShell' : 'Claude Code',
    backgroundColor: '#0c0c0c',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0c0c', symbolColor: '#ffffff', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  terminalWindows.set(win.webContents.id, id);
  const wcId = win.webContents.id;
  win.loadFile(path.join(__dirname, 'terminal', 'terminal.html'), {
    query: { id, kind: kind || '', cwd: cwd || '', server: settings.server },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    const sid = terminalWindows.get(wcId);
    terminalWindows.delete(wcId);
    // 창을 닫으면 원격 프로세스도 종료 (연결이 끊긴 경우엔 서버에서 계속 살아 있어 다시 붙을 수 있다)
    if (sid) api('DELETE', `/api/terminals/${sid}`);
  });
  return id;
}

ipcMain.handle('terminal:open', (_e, opts) => openTerminal(opts));
ipcMain.handle('terminal:attached', () => [...terminalWindows.values()]);
ipcMain.handle('window:new', (_e, startPath) => {
  createExplorer(startPath);
});
ipcMain.handle('window:title', (e, title) => {
  BrowserWindow.fromWebContents(e.sender)?.setTitle(title);
});

nativeTheme.on('updated', () => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!terminalWindows.has(w.webContents.id)) w.setTitleBarOverlay?.({ ...themeColors(), height: 40 });
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => createExplorer());

app.whenReady().then(() => {
  loadSettings();
  Menu.setApplicationMenu(null);
  createExplorer(null, { home: true });
  ensureTunnel();
});

app.on('window-all-closed', () => {
  for (const w of watchers.values()) w.watcher.close();
  app.quit();
});
