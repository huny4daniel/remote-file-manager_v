import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';

export type TerminalKind = 'claude' | 'claude-continue' | 'shell';

interface Session {
  id: string;
  kind: TerminalKind;
  cwd: string;
  createdAt: number;
  proc: pty.IPty;
  chunks: string[];
  bufferedBytes: number;
  clients: Set<WebSocket>;
  exitCode: number | null;
  cols: number;
  rows: number;
}

const SESSION_ENV_MARKERS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

type ClientMsg = { t: 'i'; d: string } | { t: 'r'; cols: number; rows: number };

export class TerminalManager {
  private sessions = new Map<string, Session>();

  constructor(private cfg: Config) {}

  create(kind: TerminalKind, cwd: string, cols = 120, rows = 30): Session {
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw Object.assign(new Error('폴더를 찾을 수 없습니다'), { code: 'ENOENT' });
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // 서버가 Claude Code 안에서 실행된 경우 중첩 세션 감지 변수가 따라 들어가지 않게 제거
    for (const k of SESSION_ENV_MARKERS) delete env[k];
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';

    const args = ['-NoLogo'];
    if (kind !== 'shell') {
      const cmd = kind === 'claude-continue' ? `${this.cfg.claudeCommand} --continue` : this.cfg.claudeCommand;
      // 셸 안에서 실행해 Claude Code가 끝나도 같은 위치의 터미널이 남게 한다
      args.push('-NoExit', '-Command', cmd);
    }

    const proc = pty.spawn(this.cfg.shell, args, { name: 'xterm-256color', cols, rows, cwd, env });
    const s: Session = {
      id: crypto.randomUUID(),
      kind,
      cwd,
      createdAt: Date.now(),
      proc,
      chunks: [],
      bufferedBytes: 0,
      clients: new Set(),
      exitCode: null,
      cols,
      rows,
    };

    proc.onData((data) => {
      s.chunks.push(data);
      s.bufferedBytes += data.length;
      while (s.bufferedBytes > this.cfg.scrollbackBytes && s.chunks.length > 1) {
        s.bufferedBytes -= s.chunks.shift()!.length;
      }
      this.broadcast(s, { t: 'o', d: data });
    });
    proc.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      this.broadcast(s, { t: 'x', code: exitCode });
      if (s.clients.size === 0) this.sessions.delete(s.id);
    });

    this.sessions.set(s.id, s);
    return s;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      kind: s.kind,
      cwd: s.cwd,
      createdAt: s.createdAt,
      attached: s.clients.size,
      exited: s.exitCode !== null,
    }));
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.exitCode === null) {
      try {
        s.proc.kill();
      } catch {
        /* 이미 종료됨 */
      }
    }
    for (const c of s.clients) c.close(1000, 'killed');
    this.sessions.delete(id);
    return true;
  }

  attach(id: string, ws: WebSocket) {
    const s = this.sessions.get(id);
    if (!s) {
      ws.send(JSON.stringify({ t: 'e', message: '세션이 종료되었거나 존재하지 않습니다' }));
      ws.close(4404, 'not found');
      return;
    }
    s.clients.add(ws);
    ws.send(JSON.stringify({ t: 'hello', id: s.id, kind: s.kind, cwd: s.cwd }));
    if (s.chunks.length) ws.send(JSON.stringify({ t: 'o', d: s.chunks.join('') }));
    if (s.exitCode !== null) ws.send(JSON.stringify({ t: 'x', code: s.exitCode }));

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (s.exitCode !== null) return;
      if (msg.t === 'i') s.proc.write(msg.d);
      else if (msg.t === 'r' && msg.cols > 0 && msg.rows > 0 && (msg.cols !== s.cols || msg.rows !== s.rows)) {
        s.cols = msg.cols;
        s.rows = msg.rows;
        s.proc.resize(msg.cols, msg.rows);
      }
    });
    ws.on('close', () => {
      s.clients.delete(ws);
      if (s.exitCode !== null && s.clients.size === 0) this.sessions.delete(s.id);
    });
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private broadcast(s: Session, msg: object) {
    const text = JSON.stringify(msg);
    for (const c of s.clients) if (c.readyState === c.OPEN) c.send(text);
  }
}
