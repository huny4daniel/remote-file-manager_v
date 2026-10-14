import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import { makeIpFilter, type Config } from './config.js';
import { fsRouter } from './fsapi.js';
import { TerminalManager, type TerminalKind } from './terminals.js';
import { getKnownFolders, type KnownFolder } from './winshell.js';

export interface RunningServer {
  terminals: TerminalManager;
  /** 노트북에서 입력할 접속 주소 목록 (host:port) */
  addresses: string[];
  close(): void;
}

/** 이 PC의 내부망 IPv4 주소 (WireGuard 인터페이스 포함) */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}

/** shutdown.exe 실행 (/s /t N: N초 뒤 종료, /a: 예약 취소) */
function runShutdown(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('shutdown.exe', args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve();
    });
  });
}

const MAX_SHUTDOWN_DELAY = 24 * 60 * 60 - 1;

/**
 * appVersion: 트레이 앱 버전 — 백그라운드 서버가 옛 버전이면 트레이가 새 버전으로 바꿔 띄운다
 * onExitRequest: 같은 PC의 트레이가 백그라운드 서버를 끄라고 요청할 때 (부팅 작업으로 뜬 프로세스는
 *                같은 계정이어도 트레이에서 직접 종료할 권한이 없다)
 */
export function startServer(
  cfg: Config,
  { appVersion = '', onExitRequest }: { appVersion?: string; onExitRequest?: () => void } = {},
): Promise<RunningServer> {
  // 예약된 종료 시각(epoch ms). 서버를 다시 켜면 모르지만 Windows 쪽 예약은 남아 있어 취소는 된다
  let shutdownAt = 0;
  const pendingShutdown = () => (shutdownAt > Date.now() ? shutdownAt : 0);

  const allowIp = makeIpFilter(cfg.allowedIps);
  const terminals = new TerminalManager(cfg);
  let knownFolders: KnownFolder[] = [];
  getKnownFolders().then((f) => (knownFolders = f));

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!allowIp(req.socket.remoteAddress)) {
      console.warn(`[차단] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
      return res.status(403).json({ code: 'EFORBIDDEN', message: `허용되지 않은 주소입니다 (${req.socket.remoteAddress})` });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/info', (_req, res) => {
    res.json({
      app: 'remote-file-manager',
      version: 1,
      appVersion,
      pid: process.pid,
      hostname: os.hostname(),
      user: os.userInfo().username,
      home: os.homedir(),
      platform: process.platform,
      sep: process.platform === 'win32' ? '\\' : '/',
      knownFolders,
      shutdownAt: pendingShutdown(),
    });
  });

  /** PC 끄기. delaySeconds가 없으면 10초 뒤 (그 사이 취소 가능) */
  app.post('/api/power/shutdown', async (req, res) => {
    const delay = Math.round(Number(req.body?.delaySeconds ?? 10));
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_SHUTDOWN_DELAY) {
      return res.status(400).json({ code: 'EINVAL', message: '종료 시간이 올바르지 않습니다' });
    }
    try {
      // 이미 걸린 예약이 있으면 shutdown.exe가 거부하므로 먼저 지운다
      await runShutdown(['/a']).catch(() => {});
      await runShutdown(['/s', '/t', String(delay)]);
      shutdownAt = Date.now() + delay * 1000;
      res.json({ shutdownAt });
    } catch (e: any) {
      res.status(500).json({ code: 'ESHUTDOWN', message: `종료할 수 없습니다: ${e.message}` });
    }
  });
  app.post('/api/power/cancel', async (_req, res) => {
    await runShutdown(['/a']).catch(() => {});
    shutdownAt = 0;
    res.json({ ok: true });
  });

  app.post('/api/server/exit', (req, res) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!onExitRequest || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
      return res.status(403).json({ code: 'EFORBIDDEN', message: '이 PC에서만 요청할 수 있습니다' });
    }
    res.json({ ok: true });
    setTimeout(onExitRequest, 100);
  });

  app.use('/api/fs', fsRouter());

  app.get('/api/terminals', (_req, res) => res.json(terminals.list()));
  app.post('/api/terminals', (req, res) => {
    const kind: TerminalKind = ['claude', 'claude-continue', 'shell'].includes(req.body.kind) ? req.body.kind : 'claude';
    try {
      const s = terminals.create(kind, String(req.body.cwd ?? ''), req.body.cols, req.body.rows);
      res.json({ id: s.id });
    } catch (e: any) {
      res.status(e.code === 'ENOENT' ? 404 : 500).json({ code: e.code ?? 'EUNKNOWN', message: e.message });
    }
  });
  app.delete('/api/terminals/:id', (req, res) => {
    res.json({ ok: terminals.kill(req.params.id) });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const m = /^\/ws\/terminals\/([\w-]+)$/.exec(req.url ?? '');
    if (!m || !allowIp(req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => terminals.attach(m[1], ws));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      const hosts = cfg.host === '0.0.0.0' ? lanAddresses() : [cfg.host];
      resolve({
        terminals,
        addresses: hosts.map((h) => `${h}:${cfg.port}`),
        close() {
          terminals.killAll();
          server.close();
        },
      });
    });
  });
}
