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

export function startServer(cfg: Config): Promise<RunningServer> {
  const allowIp = makeIpFilter(cfg.allowedIps);
  const terminals = new TerminalManager(cfg);
  let knownFolders: KnownFolder[] = [];
  getKnownFolders().then((f) => (knownFolders = f));

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!allowIp(req.socket.remoteAddress)) {
      console.warn(`[차단] ${req.socket.remoteAddress} ${req.method} ${req.url}`);
      return res.status(403).json({ code: 'EFORBIDDEN', message: '허용되지 않은 주소입니다' });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/info', (_req, res) => {
    res.json({
      app: 'remote-file-manager',
      version: 1,
      hostname: os.hostname(),
      user: os.userInfo().username,
      home: os.homedir(),
      platform: process.platform,
      sep: process.platform === 'win32' ? '\\' : '/',
      knownFolders,
    });
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
