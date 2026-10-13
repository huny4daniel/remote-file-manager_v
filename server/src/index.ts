import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadConfig, makeIpFilter, rootDir } from './config.js';
import { fsRouter } from './fsapi.js';
import { TerminalManager, type TerminalKind } from './terminals.js';
import { getKnownFolders, type KnownFolder } from './winshell.js';

const cfg = loadConfig();
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
    app: 'remote-file',
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

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `포트 ${cfg.port}가 이미 사용 중입니다 (서버가 이미 실행 중일 수 있음)` : err);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  fs.writeFileSync(path.join(rootDir, 'server.pid'), String(process.pid));
  console.log(`remote-file 서버 실행 중: http://${cfg.host}:${cfg.port}`);
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
  if (cfg.host === '0.0.0.0') console.log(`접속 가능한 주소: ${addrs.map((a) => `${a}:${cfg.port}`).join(', ')}`);
  console.log(`허용 IP 대역: ${cfg.allowedIps.length ? cfg.allowedIps.join(', ') : '(전체)'}`);
});

const shutdown = () => {
  terminals.killAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
