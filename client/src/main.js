const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme, clipboard, Notification, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

app.setAppUserModelId('remotefile.explorer');

// ───────────────────────── 설정 ─────────────────────────
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { server: '', recent: [] };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    /* 첫 실행 */
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
  recent: settings.recent,
  info: remoteInfo,
  explorer: await readExplorerPrefs(),
}));
ipcMain.handle('connection:connect', async (_e, input) => {
  let server;
  try {
    server = normalizeServer(input);
  } catch {
    return { ok: false, message: '주소 형식이 올바르지 않습니다' };
  }
  const r = await api('GET', '/api/info', { server });
  if (!r.ok || r.data?.app !== 'remote-file') return { ok: false, message: r.data?.message || '원격 PC 서버가 응답하지 않습니다' };
  settings.server = server;
  settings.recent = [server, ...settings.recent.filter((s) => s !== server)].slice(0, 8);
  saveSettings();
  remoteInfo = r.data;
  return { ok: true, server, info: remoteInfo };
});
ipcMain.handle('connection:info', async () => {
  const r = await api('GET', '/api/info');
  if (r.ok) remoteInfo = r.data;
  return r;
});

// ───────────────────────── WireWOL 설정 파일 (wirewol_settings.json) ─────────────────────────
// WireWOL(안드로이드/PC) 앱이 내보낸 암호화 설정 파일에서 PC 주소와 MAC을 가져온다.
// 형식은 wire-wol-pc_v의 app/settings_backup.py와 같다:
//   겉 {"format":"wirewol-settings","version":1,"kdf":{PBKDF2-HMAC-SHA256,iterations,salt},
//       "cipher":{AES-256-GCM,nonce},"data":b64(암호문+16바이트 태그)}
//   속 {"pairing":{host,port,token,mac}|null, "wireguard_conf", "router_wol", "auto_shutdown"}
// 토큰·WireGuard 키·공유기 비밀번호는 여기서 쓰지 않으므로 저장하지 않는다.
const WIREWOL_FILE = 'wirewol_settings.json';

function readWireWolEnvelope(file) {
  let env;
  try {
    env = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const ok =
    env?.format === 'wirewol-settings' &&
    env.version === 1 &&
    env.kdf?.name === 'PBKDF2-HMAC-SHA256' &&
    env.cipher?.name === 'AES-256-GCM' &&
    Number.isInteger(Number(env.kdf.iterations)) &&
    Number(env.kdf.iterations) >= 1 &&
    Number(env.kdf.iterations) <= 10_000_000 &&
    typeof env.kdf.salt === 'string' &&
    typeof env.cipher.nonce === 'string' &&
    typeof env.data === 'string';
  return ok ? env : null;
}

ipcMain.handle('wirewol:pick', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const desktop = path.join(app.getPath('desktop'), WIREWOL_FILE);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'WireWOL 설정 파일 불러오기',
    defaultPath: fs.existsSync(desktop) ? desktop : app.getPath('desktop'),
    filters: [{ name: 'WireWOL 설정 파일', extensions: ['json'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('wirewol:check', (_e, file) =>
  readWireWolEnvelope(file) ? { ok: true, name: path.basename(file) } : { ok: false, message: 'WireWOL 설정 파일이 아닙니다' },
);

ipcMain.handle('wirewol:import', async (_e, file, password) => {
  const env = readWireWolEnvelope(file);
  if (!env) return { ok: false, message: 'WireWOL 설정 파일이 아닙니다' };
  const key = await new Promise((resolve, reject) =>
    crypto.pbkdf2(Buffer.from(String(password), 'utf8'), Buffer.from(env.kdf.salt, 'base64'), Number(env.kdf.iterations), 32, 'sha256', (err, k) =>
      err ? reject(err) : resolve(k),
    ),
  );
  const data = Buffer.from(env.data, 'base64');
  if (data.length < 17) return { ok: false, message: 'WireWOL 설정 파일이 손상되었습니다' };
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.cipher.nonce, 'base64'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  } catch {
    return { ok: false, wrongPassword: true, message: '비밀번호가 올바르지 않습니다' };
  }
  let pairing;
  try {
    pairing = JSON.parse(plain.toString('utf8')).pairing;
  } catch {
    return { ok: false, message: 'WireWOL 설정 파일이 손상되었습니다' };
  }
  const host = String(pairing?.host || '').trim();
  if (!host) return { ok: false, message: '이 설정 파일에는 등록된 PC가 없습니다' };
  const mac = String(pairing.mac || '').trim();
  settings.wol = { host, mac: parseMac(mac) ? mac : '' };
  saveSettings();
  return { ok: true, host, mac: settings.wol.mac };
});

// ───────────────────────── Wake-on-LAN (WireWOL과 같은 방식) ─────────────────────────
function parseMac(mac) {
  const parts = String(mac || '').trim().split(/[:-]/).filter(Boolean);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/i.test(p))) return null;
  return Buffer.from(parts.map((p) => parseInt(p, 16)));
}

/** 연결하려는 주소가 WireWOL에서 가져온 PC면 그 정보를 돌려준다 */
function wolTarget(input) {
  const w = settings.wol;
  if (!w?.mac) return null;
  try {
    return new URL(normalizeServer(input || settings.server)).hostname === w.host ? w : null;
  } catch {
    return null;
  }
}

ipcMain.handle('wol:available', (_e, input) => !!wolTarget(input));
ipcMain.handle('wol:wake', async (_e, input) => {
  const w = wolTarget(input);
  const mac = w && parseMac(w.mac);
  if (!mac) return { ok: false, message: 'PC의 MAC 주소를 모릅니다' };
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
  // 255.255.255.255는 WireGuard 터널을 넘지 못하므로 /24 지정 브로드캐스트와 PC 주소로도 보낸다
  const targets = ['255.255.255.255'];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(w.host)) targets.push(w.host.replace(/\.\d+$/, '.255'), w.host);
  const sock = require('node:dgram').createSocket('udp4');
  await new Promise((resolve) => sock.bind(() => resolve()));
  sock.setBroadcast(true);
  await Promise.all(targets.map((t) => new Promise((resolve) => sock.send(packet, 9, t, () => resolve()))));
  sock.close();
  return { ok: true };
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
const cacheRoot = () => path.join(app.getPath('temp'), 'RemoteFile', 'open');
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
  const dir = `${info.home}\\.remote-file\\inbox`;
  await api('POST', '/api/fs/mkdirp', { body: { path: dir } });
  const out = [];
  if (payload.image) {
    const png = await clipboardPng();
    if (!png) return [];
    const tmp = path.join(app.getPath('temp'), 'RemoteFile', `paste-${Date.now()}.png`);
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

function createExplorer(startPath) {
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
  win.loadFile(path.join(__dirname, 'explorer', 'explorer.html'), { query: startPath ? { path: startPath } : {} });
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
  createExplorer();
});

app.on('window-all-closed', () => {
  for (const w of watchers.values()) w.watcher.close();
  app.quit();
});
