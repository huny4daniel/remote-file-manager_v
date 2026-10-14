/*
 * WireWOL 내장 — github.com/huny4daniel/wire-wol-pc_v (WireWOL PC)의 동작을 옮긴 것.
 *
 *  - 내장 WireGuard: wireguard-windows embeddable-dll-service를 "WireGuardTunnel$rfm" 서비스로 돌린다.
 *    WireWOL PC는 앱을 매번 관리자 권한으로 띄워 켤 때 서비스를 만들고 끌 때 지우지만, 여기서는
 *    처음 한 번만 UAC로 서비스를 설치하면서 현재 사용자에게 시작/중지 권한을 준다 — 이후엔 일반 권한으로
 *    켜고 끈다(관리자 창은 일반 탐색기에서 끌어다 놓기를 받지 못해서).
 *  - 컴패니언(WireWOL 윈도우 컴패니언) 핑/종료, 매직 패킷, 공유기 원격 WOL(TOFU)
 *  - 설정 내보내기/불러오기: WireWOL(안드로이드/PC)과 같은 wirewol_settings.json 형식
 *  - 비밀 값(WireGuard 개인키, 컴패니언 토큰, 공유기 비밀번호)은 safeStorage(DPAPI)로 암호화해 저장
 */
const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const https = require('node:https');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// ───────────────────────── 비밀 설정 저장소 ─────────────────────────
// { wireguardConf, routerWol: {host,port,id,password}, routerCertFp: {host: fp},
//   autoShutdown: {enabled, delay_minutes}, pairings: { [pcId]: {host,port,token} } }
const secretsFile = () => path.join(app.getPath('userData'), 'wirewol-secrets.bin');
let secrets = null;

function loadSecrets() {
  if (secrets) return secrets;
  secrets = { pairings: {} };
  try {
    const raw = fs.readFileSync(secretsFile());
    secrets = { pairings: {}, ...JSON.parse(safeStorage.decryptString(raw)) };
  } catch {
    /* 처음 실행이거나 다른 계정에서 만든 파일 */
  }
  return secrets;
}
function saveSecrets() {
  fs.mkdirSync(path.dirname(secretsFile()), { recursive: true });
  const tmp = `${secretsFile()}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(secrets)));
  fs.renameSync(tmp, secretsFile());
}
const getSecrets = () => loadSecrets();
function updateSecrets(fn) {
  loadSecrets();
  fn(secrets);
  saveSecrets();
}

// ───────────────────────── 실행 도우미 ─────────────────────────
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 내장 WireGuard 터널 ─────────────────────────
const TUNNEL_NAME = 'rfm';
const SERVICE = `WireGuardTunnel$${TUNNEL_NAME}`;
const RUNTIME_FILES = ['tunnel.dll', 'wireguard.dll', 'rfm-tunnel-host.exe'];
const DATA_ROOT = path.join(process.env.ProgramData || 'C:\\ProgramData', 'RemoteFileManager');
const INSTALL_DIR = path.join(DATA_ROOT, 'tunnel');
const CONF_DIR = path.join(DATA_ROOT, 'conf');
const CONF_PATH = path.join(CONF_DIR, `${TUNNEL_NAME}.conf`);
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 20000;

const runtimeDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'tunnel') : path.join(__dirname, '..', 'tunnel', 'bin'));
const setupScript = () => path.join(__dirname, 'tunnel-setup.ps1').replace('app.asar', 'app.asar.unpacked');

/** sc.exe query 결과 → 'missing' | 'stopped' | 'starting' | 'stopping' | 'running' */
async function serviceState() {
  const r = await run('sc.exe', ['query', SERVICE]);
  if (r.code === 1060) return 'missing';
  const m = /STATE\s*:\s*(\d+)/.exec(r.stdout);
  return { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running' }[m?.[1]] || 'stopped';
}

/** 서비스가 있고, 설치된 실행 파일이 이 버전에 들어 있는 것과 같은지 */
async function tunnelInstalled() {
  if ((await serviceState()) === 'missing') return false;
  for (const name of RUNTIME_FILES) {
    try {
      const [a, b] = await Promise.all([fsp.readFile(path.join(runtimeDir(), name)), fsp.readFile(path.join(INSTALL_DIR, name))]);
      if (!a.equals(b)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
const runtimeBundled = () => RUNTIME_FILES.every((n) => fs.existsSync(path.join(runtimeDir(), n)));

/** 관리자 권한(UAC)으로 tunnel-setup.ps1 실행 — 파일 배치, 서비스 생성, 현재 사용자에게 시작/중지 권한 부여 */
async function installTunnel() {
  if (!runtimeBundled()) return { ok: false, message: '이 빌드에는 내장 WireGuard 파일이 들어 있지 않습니다' };
  const sid = (await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'])).stdout.trim().split(',').pop()?.replace(/"/g, '');
  if (!/^S-1-[\d-]+$/.test(sid || '')) return { ok: false, message: '현재 사용자 정보를 확인할 수 없습니다' };
  const log = path.join(app.getPath('temp'), 'rfm-tunnel-setup.log');
  await fsp.rm(log, { force: true });
  // Start-Process의 ArgumentList는 공백 든 경로를 따옴표로 감싸지 않으므로 한 문자열로 직접 만든다
  const r = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$a = '-NoProfile -ExecutionPolicy Bypass -File \"{0}\" -Source \"{1}\" -UserSid {2} -LogFile \"{3}\"' -f $env:RFM_SCRIPT, $env:RFM_SRC, $env:RFM_SID, $env:RFM_LOG; " +
        '$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $a; exit $p.ExitCode',
    ],
    { env: { ...process.env, RFM_SCRIPT: setupScript(), RFM_SRC: runtimeDir(), RFM_SID: sid, RFM_LOG: log } },
  );
  if (r.code === 0) return { ok: true };
  const detail = await fsp.readFile(log, 'utf8').catch(() => '');
  if (!detail && /cancel|취소/i.test(r.stderr)) return { ok: false, cancelled: true, message: '관리자 권한 요청이 취소되었습니다' };
  return { ok: false, message: `내장 WireGuard를 설치할 수 없습니다: ${(detail || r.stderr).trim().split(/\r?\n/).pop()}` };
}

async function waitService(wanted, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = await serviceState();
    if (s === wanted || s === 'stopped' || s === 'missing' || Date.now() > deadline) return s;
    await sleep(250);
  }
}

let tunnelBusy = Promise.resolve();
const serial = (fn) => (tunnelBusy = tunnelBusy.then(fn, fn));

/**
 * 터널이 집 PC로 가는 트래픽만 맡도록 .conf를 고친다(저장된 원본은 그대로).
 *  - 첫 [Peer]의 AllowedIPs를 allowedIps로 바꾸고 나머지 피어의 AllowedIPs는 뺀다 — 0.0.0.0/0이 없으니
 *    wireguard-windows의 kill switch(터널 밖 통신 차단)도 켜지지 않는다. 그래서 집 안에서 켜졌거나
 *    핸드셰이크가 안 되는 터널이어도 노트북 인터넷은 끊기지 않는다.
 *  - [Interface]의 DNS를 뺀다 — 터널 DNS(보통 집 공유기)는 터널이 막히면 이름 풀이 전체를 막는다.
 */
function splitConf(conf, allowedIps) {
  let section = '';
  let peers = 0;
  const out = [];
  for (const line of conf.split(/\r?\n/)) {
    const head = /^\s*\[(\w+)\]/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      out.push(line);
      if (section === 'peer' && ++peers === 1) out.push(`AllowedIPs = ${allowedIps.join(', ')}`);
      continue;
    }
    if (section === 'peer' && /^\s*AllowedIPs\s*=/i.test(line)) continue;
    if (section === 'interface' && /^\s*DNS\s*=/i.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function tunnelUp(conf, allowedIps) {
  return serial(async () => {
    if ((await serviceState()) === 'running') return;
    await fsp.writeFile(CONF_PATH, `${splitConf(conf, allowedIps).trim()}\n`);
    try {
      const r = await run('sc.exe', ['start', SERVICE]);
      if (r.code !== 0 && r.code !== 1056) throw new Error(`WireGuard 터널을 시작할 수 없습니다 (${r.stdout.trim().split(/\r?\n/).pop() || r.code})`);
      const s = await waitService('running', START_TIMEOUT_MS);
      if (s !== 'running') throw new Error('WireGuard 터널을 시작할 수 없습니다 — 설정 내용을 확인하세요');
    } finally {
      // 서비스는 시작할 때 한 번만 읽는다 — 개인키가 든 파일을 디스크에 남기지 않는다
      await fsp.rm(CONF_PATH, { force: true });
    }
  });
}

function tunnelDown() {
  return serial(async () => {
    const s = await serviceState();
    if (s === 'missing' || s === 'stopped') return;
    await run('sc.exe', ['stop', SERVICE]);
    await waitService('stopped', STOP_TIMEOUT_MS);
  });
}

// ───────────────────────── 네트워크 ─────────────────────────
function tcpProbe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    if (!host || !(Number(port) > 0)) return resolve(false);
    const sock = net.connect({ host, port: Number(port) });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function parseMac(mac) {
  const parts = String(mac || '').trim().split(/[:-]/).filter(Boolean);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/i.test(p))) return null;
  return Buffer.from(parts.map((p) => parseInt(p, 16)));
}

/** 255.255.255.255는 WireGuard 터널을 넘지 못하므로 /24 지정 브로드캐스트와 PC 주소로도 보낸다 */
async function sendMagicPacket(mac, host) {
  const m = parseMac(mac);
  if (!m) throw new Error('MAC 주소 형식이 올바르지 않습니다');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
  const targets = ['255.255.255.255'];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host || '')) targets.push(host.replace(/\.\d+$/, '.255'), host);
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve) => sock.bind(() => resolve()));
  sock.setBroadcast(true);
  await Promise.all(targets.map((t) => new Promise((resolve) => sock.send(packet, 9, t, () => resolve()))));
  sock.close();
}

// ───────────────────────── WireWOL 컴패니언 ─────────────────────────
// 와이어가드를 막 켠 직후 첫 요청은 핸드셰이크가 끝나야 나가므로 짧은 타임아웃은 실패하기 쉽다
const COMPANION_TIMEOUT_MS = 8000;

async function companionCall(pairing, method, apiPath, body, timeout = COMPANION_TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(`http://${pairing.host}:${pairing.port}${apiPath}`, {
      method,
      headers: { 'X-WireWOL-Token': pairing.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(e.cause?.code || '연결할 수 없습니다');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const companionPing = (p, timeout) => companionCall(p, 'GET', '/api/ping', undefined, timeout);
const companionShutdown = (p, delaySeconds) => companionCall(p, 'POST', '/api/shutdown', delaySeconds == null ? null : { delay_seconds: delaySeconds });
const companionCancel = (p) => companionCall(p, 'POST', '/api/shutdown/cancel', null);

// ───────────────────────── 공유기 원격 WOL (iptime 등) ─────────────────────────
// 자체 서명 인증서라 처음 본 지문을 저장해두고 이후 비교한다(TOFU). TLS 1.3에서 응답 없이 끊는
// 공유기가 있어 1.2로 고정한다.
function routerCall(router, body, cookie) {
  return new Promise((resolve, reject) => {
    const origin = `https://${router.host}:${router.port}`;
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        host: router.host,
        port: Number(router.port),
        path: '/cgi/service.cgi',
        method: 'POST',
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        agent: false,
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'Mozilla/5.0 (Windows NT) WireWOL',
          Accept: 'application/json, text/plain, */*',
          Connection: 'close',
          Origin: origin,
          Referer: `${origin}/`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`공유기 요청 실패 (HTTP ${res.statusCode})`));
          const setCookie = res.headers['set-cookie']?.[0]?.split(';')[0];
          let json = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            /* 본문이 JSON이 아님 */
          }
          resolve({ json, cookie: setCookie || cookie });
        });
      },
    );
    req.on('socket', (sock) =>
      sock.once('secureConnect', () => {
        const der = sock.getPeerCertificate(true)?.raw;
        if (!der) return req.destroy(new Error('공유기가 인증서를 제공하지 않았습니다'));
        const fp = crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
        const pinned = getSecrets().routerCertFp?.[router.host];
        if (!pinned) updateSecrets((s) => (s.routerCertFp = { ...s.routerCertFp, [router.host]: fp }));
        else if (pinned !== fp) req.destroy(new Error('공유기 인증서가 이전과 달라 신뢰할 수 없습니다(공유기를 교체했다면 원격 WOL 설정을 다시 저장하세요)'));
      }),
    );
    req.on('timeout', () => req.destroy(new Error('공유기 응답 시간 초과')));
    req.on('error', (e) => reject(e.message?.startsWith('공유기') ? e : new Error(`공유기에 연결할 수 없습니다: ${e.message}`)));
    req.end(payload);
  });
}

async function routerWake(mac) {
  const router = getSecrets().routerWol;
  if (!router) return false;
  const login = await routerCall(router, { method: 'session/login', params: { id: router.id, pw: router.password } });
  if (login.json.result !== 'done') throw new Error('공유기 로그인 실패 — ID/비밀번호를 확인하세요');
  await routerCall(router, { method: 'wol/signal', params: [mac] }, login.cookie);
  return true;
}

// ───────────────────────── 설정 파일 (wirewol_settings.json) ─────────────────────────
// 겉 {"format":"wirewol-settings","version":1,"kdf":{PBKDF2-HMAC-SHA256,iterations,salt},
//     "cipher":{AES-256-GCM,nonce},"data":b64(암호문+16바이트 태그)}
// 속 {"pairing":{host,port,token,mac}|null,"wireguard_conf","router_wol":{host,port,id,password}|null,
//     "auto_shutdown":{enabled,delay_minutes}}
const BACKUP_FORMAT = 'wirewol-settings';
const BACKUP_ITERATIONS = 200000;
const DEFAULT_AUTO_SHUTDOWN_MINUTES = 60;

const deriveKey = (password, salt, iterations) =>
  new Promise((resolve, reject) =>
    crypto.pbkdf2(Buffer.from(String(password), 'utf8'), salt, iterations, 32, 'sha256', (err, k) => (err ? reject(err) : resolve(k))),
  );

function readBackupEnvelope(file) {
  let env;
  try {
    env = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const iterations = Number(env?.kdf?.iterations);
  const ok =
    env?.format === BACKUP_FORMAT &&
    env.version === 1 &&
    env.kdf?.name === 'PBKDF2-HMAC-SHA256' &&
    env.cipher?.name === 'AES-256-GCM' &&
    Number.isInteger(iterations) &&
    iterations >= 1 &&
    iterations <= 10_000_000 &&
    typeof env.kdf.salt === 'string' &&
    typeof env.cipher.nonce === 'string' &&
    typeof env.data === 'string';
  return ok ? env : null;
}

async function decryptBackup(file, password) {
  const env = readBackupEnvelope(file);
  if (!env) return { ok: false, message: 'WireWOL 설정 파일이 아닙니다' };
  const data = Buffer.from(env.data, 'base64');
  if (data.length < 17) return { ok: false, message: 'WireWOL 설정 파일이 손상되었습니다' };
  const key = await deriveKey(password, Buffer.from(env.kdf.salt, 'base64'), Number(env.kdf.iterations));
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.cipher.nonce, 'base64'));
    d.setAuthTag(data.subarray(data.length - 16));
    plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  } catch {
    return { ok: false, wrongPassword: true, message: '비밀번호가 올바르지 않습니다' };
  }
  let c;
  try {
    c = JSON.parse(plain.toString('utf8'));
  } catch {
    return { ok: false, message: 'WireWOL 설정 파일이 손상되었습니다' };
  }
  // port는 문자열/숫자 어느 쪽이 와도 받는다(페어링 QR은 숫자로 담는다)
  let pairing = c.pairing ? { host: String(c.pairing.host || ''), port: String(c.pairing.port || ''), token: String(c.pairing.token || ''), mac: String(c.pairing.mac || '') } : null;
  if (pairing && !(pairing.host && pairing.port && pairing.token)) pairing = null;
  const r = c.router_wol;
  const routerWol = r ? { host: String(r.host), port: String(r.port), id: String(r.id), password: String(r.password) } : null;
  const delay = c.auto_shutdown?.delay_minutes;
  return {
    ok: true,
    contents: {
      pairing,
      wireguardConf: c.wireguard_conf || null,
      routerWol,
      autoShutdown: {
        enabled: !!c.auto_shutdown?.enabled,
        delay_minutes: Number.isInteger(delay) && delay >= 1 && delay <= 23 * 60 + 59 ? delay : DEFAULT_AUTO_SHUTDOWN_MINUTES,
      },
    },
  };
}

async function encryptBackup(contents, password) {
  const plain = Buffer.from(JSON.stringify(contents), 'utf8');
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = await deriveKey(password, salt, BACKUP_ITERATIONS);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: 1,
      kdf: { name: 'PBKDF2-HMAC-SHA256', iterations: BACKUP_ITERATIONS, salt: salt.toString('base64') },
      cipher: { name: 'AES-256-GCM', nonce: nonce.toString('base64') },
      data: data.toString('base64'),
    },
    null,
    2,
  );
}

module.exports = {
  TUNNEL_NAME,
  getSecrets,
  updateSecrets,
  serviceState,
  tunnelInstalled,
  runtimeBundled,
  installTunnel,
  tunnelUp,
  tunnelDown,
  tcpProbe,
  parseMac,
  sendMagicPacket,
  companionPing,
  companionShutdown,
  companionCancel,
  routerWake,
  readBackupEnvelope,
  decryptBackup,
  encryptBackup,
  BACKUP_FILE: 'wirewol_settings.json',
};
