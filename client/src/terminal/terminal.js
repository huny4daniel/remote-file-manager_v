/* 원격 PC의 PTY(PowerShell / Claude Code)를 그대로 보여주는 터미널 창 */
'use strict';

const params = new URLSearchParams(location.search);
const sessionId = params.get('id');
const kind = params.get('kind') || 'claude';
const cwd = params.get('cwd') || '';
const wsUrl = `${params.get('server').replace(/^http/, 'ws')}/ws/terminals/${sessionId}`;

const baseTitle = kind === 'shell' ? 'Windows PowerShell' : 'Claude Code';
const folder = cwd.replace(/\\+$/, '').split('\\').pop() || cwd;
const glyph = document.getElementById('tab-glyph');
if (kind === 'shell') {
  glyph.textContent = '';
  glyph.className = 'shell';
} else glyph.textContent = '✻';

function setTitle(t) {
  const title = t || (folder ? `${baseTitle} — ${folder}` : baseTitle);
  // 프로그램이 제목 앞에 자체 기호를 붙이면(Claude Code의 ✳ 등) 탭 기호는 숨긴다
  glyph.hidden = !!t && !/^[\p{L}\p{N}]/u.test(t);
  document.getElementById('tab-title').textContent = title;
  document.title = title;
}
setTitle();

const term = new Terminal({
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'D2Coding', 'Malgun Gothic', monospace",
  fontSize: 14,
  lineHeight: 1.1,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 10000,
  allowProposedApi: true,
  windowsPty: { backend: 'conpty', buildNumber: 22631 },
  theme: {
    background: '#1f1f1f',
    foreground: '#cccccc',
    cursor: '#ffffff',
    selectionBackground: '#264f78',
    black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798',
    cyan: '#3a96dd', white: '#cccccc', brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
    brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById('term'));
fit.fit();
term.focus();
term.onTitleChange((t) => setTitle(t && t.trim() ? t : ''));

// ───────────────────────── 연결 ─────────────────────────
let ws = null;
let retry = 0;
let ended = false;
const overlay = document.getElementById('overlay');
const showOverlay = (text) => {
  overlay.hidden = !text;
  document.getElementById('overlay-text').textContent = text || '';
};
const send = (msg) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const sendResize = () => send({ t: 'r', cols: term.cols, rows: term.rows });

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    retry = 0;
    showOverlay('');
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'hello') {
      term.reset();
      sendResize();
    } else if (msg.t === 'o') term.write(msg.d);
    else if (msg.t === 'x') {
      ended = true;
      window.close();
    } else if (msg.t === 'e') {
      ended = true;
      showOverlay(msg.message);
    }
  };
  ws.onclose = (ev) => {
    if (ended) return;
    if (ev.code === 4404) {
      ended = true;
      showOverlay('세션이 종료되었습니다');
      return;
    }
    showOverlay('원격 PC와 연결이 끊어졌습니다. 다시 연결하는 중...');
    setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
connect();

term.onData((d) => send({ t: 'i', d }));
new ResizeObserver(() => {
  fit.fit();
}).observe(document.getElementById('term'));
term.onResize(sendResize);

// ───────────────────────── 클립보드 / 키 ─────────────────────────
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);

async function pasteFromClipboard() {
  // 노트북 클립보드의 이미지/파일은 원격 PC로 올린 뒤 그 경로를 입력 (Claude Code가 원격에서 읽을 수 있게)
  const files = await window.rd.clipboardFiles();
  if (files.length) return stageAndType({ paths: files });
  if (await window.rd.clipboardHasImage()) return stageAndType({ image: true });
  const text = await window.rd.readText();
  if (text) term.paste(text);
}

async function stageAndType(payload) {
  showOverlay('원격 PC로 파일을 보내는 중...');
  try {
    const remote = await window.rd.stageForTerminal(payload);
    if (remote.length) term.paste(remote.map(quote).join(' ') + ' ');
  } finally {
    showOverlay('');
  }
}

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'c' && term.hasSelection()) {
    window.rd.writeText(term.getSelection());
    term.clearSelection();
    return false;
  }
  if (e.ctrlKey && e.shiftKey && key === 'c') {
    if (term.hasSelection()) window.rd.writeText(term.getSelection());
    return false;
  }
  if (e.ctrlKey && key === 'v') {
    e.preventDefault();
    pasteFromClipboard();
    return false;
  }
  if (e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
    // Claude Code에서 줄바꿈 (Meta+Enter 와 동일)
    send({ t: 'i', d: '\x1b\r' });
    return false;
  }
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) return zoom(1), false;
  if (e.ctrlKey && e.key === '-') return zoom(-1), false;
  if (e.ctrlKey && e.key === '0') return zoom(0), false;
  return true;
});

function zoom(d) {
  term.options.fontSize = d === 0 ? 14 : Math.max(8, Math.min(32, term.options.fontSize + d));
  fit.fit();
}

// Windows Terminal처럼: 선택 영역이 있으면 우클릭=복사, 없으면 붙여넣기
document.getElementById('term').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (term.hasSelection()) {
    window.rd.writeText(term.getSelection());
    term.clearSelection();
  } else pasteFromClipboard();
});

// 노트북 파일을 끌어다 놓으면 원격 PC로 보낸 뒤 경로 입력
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => window.rd.pathForFile(f)).filter(Boolean);
  if (paths.length) stageAndType({ paths });
});
