/* 원격 PC 파일 탐색기 — Windows 11 탐색기 동작을 따른다 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ───────────────────────── 상태 ─────────────────────────
// showHidden 이 없으면 노트북 탐색기 설정을 따른다
const prefs = (() => {
  try {
    return { view: 'details', sort: { key: 'name', dir: 1 }, sidebar: 220, ...JSON.parse(localStorage.getItem('rd-prefs') || '{}') };
  } catch {
    return { view: 'details', sort: { key: 'name', dir: 1 }, sidebar: 220 };
  }
})();
let winPrefs = { hideExt: true, showHidden: false, showSystem: false };
const showHidden = () => prefs.showHidden ?? winPrefs.showHidden;
const savePrefs = () => {
  try {
    localStorage.setItem('rd-prefs', JSON.stringify(prefs));
  } catch {
    /* 무시 */
  }
};

const state = {
  info: null,
  server: '',
  drives: [],
  quick: null, // 탐색기 즐겨찾기 (불러오기 실패 시 null → 알려진 폴더로 대체)
  loc: { kind: 'pc' },
  items: [], // 화면에 보이는 순서
  raw: [],
  selected: new Set(),
  focus: -1,
  anchor: -1,
  history: [],
  hIdx: -1,
  renaming: false,
  sig: '',
  loading: false,
  connected: true,
};

// ───────────────────────── 형식 ─────────────────────────
const TYPE_NAMES = {
  txt: '텍스트 문서', md: 'Markdown 원본 파일', log: '텍스트 문서', json: 'JSON 원본 파일', js: 'JavaScript 파일',
  ts: 'TypeScript 파일', tsx: 'TSX 파일', jsx: 'JSX 파일', py: 'Python 파일', pyw: 'Python 파일 (콘솔 없음)',
  html: 'Chrome HTML Document', htm: 'Chrome HTML Document', css: '연계 스타일시트 문서', png: 'PNG 파일',
  jpg: 'JPG 파일', jpeg: 'JPEG 파일', gif: 'GIF 파일', bmp: 'BMP 파일', webp: 'WEBP 파일', svg: 'SVG 문서',
  ico: '아이콘', pdf: 'PDF 문서', zip: '압축(ZIP) 폴더', '7z': '7Z 파일', rar: 'RAR 파일', exe: '응용 프로그램',
  msi: 'Windows Installer 패키지', dll: '응용 프로그램 확장', bat: 'Windows 배치 파일', cmd: 'Windows 명령 스크립트',
  ps1: 'Windows PowerShell 스크립트', lnk: '바로 가기', ini: '구성 설정', xml: 'XML 문서', yml: 'YML 파일',
  yaml: 'YAML 파일', csv: 'Microsoft Excel 쉼표로 구분된 값 파일', xlsx: 'Microsoft Excel 워크시트',
  docx: 'Microsoft Word 문서', pptx: 'Microsoft PowerPoint 프레젠테이션', hwp: '한컴오피스 한글 문서',
  mp3: 'MP3 형식 사운드', mp4: 'MP4 비디오', mkv: 'MKV 파일', wav: 'WAV 파일', java: 'JAVA 파일', kt: 'KT 파일',
  c: 'C 원본 파일', cpp: 'C++ 원본 파일', h: 'C 헤더 파일', cs: 'C# 원본 파일', go: 'GO 파일', rs: 'RS 파일',
  sh: 'SH 파일', gitignore: 'Git Ignore 원본 파일', toml: 'TOML 파일', lock: 'LOCK 파일', sln: 'Visual Studio Solution',
};
const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : name.startsWith('.') ? name.slice(1).toLowerCase() : '';
};
// 바로 가기 확장명은 탐색기에서 항상 숨겨진다
const ALWAYS_HIDDEN_EXT = new Set(['lnk', 'url', 'pif']);
function hidesExt(it) {
  if (it.type !== 'file' || it.kind) return false;
  const ext = extOf(it.name);
  return !!ext && it.name.lastIndexOf('.') > 0 && (winPrefs.hideExt || ALWAYS_HIDDEN_EXT.has(ext));
}
function displayName(it) {
  return hidesExt(it) ? it.name.slice(0, it.name.lastIndexOf('.')) : it.name;
}

function typeName(it) {
  if (it.kind === 'drive') return driveTypeName(it.drive);
  if (it.type === 'dir') return '파일 폴더';
  const ext = extOf(it.name);
  if (!ext) return '파일';
  return TYPE_NAMES[ext] || `${ext.toUpperCase()} 파일`;
}
function driveTypeName(d) {
  return { fixed: '로컬 디스크', removable: '이동식 디스크', network: '네트워크 드라이브', cdrom: 'CD 드라이브' }[d.type] || '드라이브';
}
function driveLabel(d) {
  if (d.label) return `${d.label} (${d.letter})`;
  return `${driveTypeName(d)} (${d.letter})`;
}
function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getHours();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${p(d.getMinutes())}`;
}
function formatSize(bytes) {
  if (bytes == null) return '';
  return `${Math.ceil(bytes / 1024).toLocaleString('ko-KR')}KB`;
}
function formatBytes(b) {
  if (b == null) return '';
  const u = ['바이트', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v}${u[0]}` : `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)}${u[i]}`;
}

// ───────────────────────── 경로 ─────────────────────────
const isRoot = (p) => /^[A-Za-z]:\\?$/.test(p);
const normRoot = (p) => (/^[A-Za-z]:$/.test(p) ? `${p}\\` : p);
function parentOf(p) {
  if (isRoot(p)) return null;
  const t = p.replace(/\\+$/, '');
  const i = t.lastIndexOf('\\');
  return i <= 2 ? t.slice(0, 3) : t.slice(0, i);
}
const baseName = (p) => (isRoot(p) ? p : p.replace(/\\+$/, '').split('\\').pop());
const sameDrive = (a, b) => a.slice(0, 2).toLowerCase() === b.slice(0, 2).toLowerCase();
const locKey = (loc) => (loc.kind === 'dir' ? `dir:${loc.path.toLowerCase()}` : loc.kind === 'search' ? `s:${loc.path}|${loc.q}` : 'pc');

// ───────────────────────── 아이콘 ─────────────────────────
const iconPromises = new Map();
function iconUrl(key, size = 'small') {
  const k = `${key}|${size}`;
  if (!iconPromises.has(k)) iconPromises.set(k, window.rd.icon(key, size));
  return iconPromises.get(k);
}
function iconKeyOf(it) {
  if (it.kind === 'drive') return `drive:${it.drive.type}`;
  if (it.kind === 'known') return `known:${it.known.id}`;
  if (it.type === 'dir') return 'folder';
  return extOf(it.name);
}
function setIcon(img, key, size) {
  iconUrl(key, size).then((u) => {
    if (u) img.src = u;
  });
}

// ───────────────────────── API ─────────────────────────
async function call(method, path, opts) {
  const r = await window.rd.api(method, path, opts);
  setConnected(r.status !== 0);
  return r;
}
async function showError(message, title = '파일 탐색기') {
  await window.rd.message({ type: 'error', title, message });
}

function setConnected(ok) {
  if (state.connected === ok) return;
  state.connected = ok;
  $('#status-conn').classList.toggle('off', !ok);
  if (!ok) toast('원격 PC와 연결이 끊어졌습니다. 다시 연결하는 중...', 'error');
  else toast('원격 PC에 다시 연결되었습니다');
}

// ───────────────────────── 탐색 ─────────────────────────
function navigate(loc, { push = true, selectPath } = {}) {
  if (push) {
    state.history = state.history.slice(0, state.hIdx + 1);
    if (!state.history.length || locKey(state.history[state.hIdx]) !== locKey(loc)) {
      state.history.push(loc);
      state.hIdx = state.history.length - 1;
    }
  }
  const prev = state.loc;
  state.loc = loc;
  if (loc.kind !== 'search') $('#search-input').value = '';
  state.selected.clear();
  state.focus = -1;
  state.anchor = -1;
  load({ selectPath: selectPath ?? (prev.kind === 'dir' && loc.kind !== 'search' ? prev.path : undefined), fresh: true });
}
const goBack = () => {
  if (state.hIdx > 0) navigate(state.history[--state.hIdx], { push: false });
};
const goForward = () => {
  if (state.hIdx < state.history.length - 1) navigate(state.history[++state.hIdx], { push: false });
};
function goUp() {
  if (state.loc.kind === 'search') return navigate({ kind: 'dir', path: state.loc.path });
  if (state.loc.kind !== 'dir') return;
  const p = parentOf(state.loc.path);
  navigate(p ? { kind: 'dir', path: p } : { kind: 'pc' }, { selectPath: state.loc.path });
}
function openDir(path) {
  navigate({ kind: 'dir', path: normRoot(path) });
}

async function load({ selectPath, fresh = false, silent = false } = {}) {
  const loc = state.loc;
  if (!silent) state.loading = true;
  let items;
  if (loc.kind === 'pc') {
    const r = await call('GET', '/api/fs/drives');
    if (r.ok) state.drives = r.data;
    const known = (state.info?.knownFolders || []).map((k) => ({ kind: 'known', known: k, name: k.name, path: k.path, type: 'dir' }));
    const drives = state.drives.map((d) => ({ kind: 'drive', drive: d, name: driveLabel(d), path: d.path, type: 'dir' }));
    items = [...known, ...drives];
    renderSidebar();
  } else if (loc.kind === 'dir') {
    const r = await call('GET', '/api/fs/list', { query: { path: loc.path } });
    if (locKey(loc) !== locKey(state.loc)) return;
    if (!r.ok) {
      state.loading = false;
      if (silent) return;
      if (r.status === 0) return; // 연결 끊김: 상태 표시만
      await showError(`${loc.path}\n\n${r.data?.message || '열 수 없습니다'}`);
      if (fresh && state.hIdx > 0) {
        state.history.splice(state.hIdx, 1);
        state.hIdx--;
        state.loc = state.history[state.hIdx];
        return load({ fresh: true });
      }
      return;
    }
    loc.path = r.data.path;
    items = r.data.entries;
  } else {
    $('#status-count').textContent = '검색 중...';
    const r = await call('GET', '/api/fs/search', { query: { path: loc.path, q: loc.q } });
    if (locKey(loc) !== locKey(state.loc)) return;
    items = r.ok ? r.data.entries : [];
  }
  state.loading = false;
  state.raw = items;
  const sig = JSON.stringify(items.map((i) => [i.name, i.mtime, i.size, i.type]));
  if (silent && sig === state.sig) return;
  state.sig = sig;

  const keepSel = new Set([...state.selected].map((p) => p.toLowerCase()));
  const focusPath = state.items[state.focus]?.path.toLowerCase();
  applyItems();
  state.selected.clear();
  if (!fresh) {
    state.items.forEach((it, i) => {
      if (keepSel.has(it.path.toLowerCase())) state.selected.add(it.path);
      if (it.path.toLowerCase() === focusPath) state.focus = i;
    });
  }
  if (selectPath) {
    const i = state.items.findIndex((it) => it.path.toLowerCase() === selectPath.toLowerCase());
    if (i >= 0) {
      state.selected = new Set([state.items[i].path]);
      state.focus = state.anchor = i;
    }
  }
  render();
  if (selectPath) scrollToFocus();
}

function applyItems() {
  if (state.loc.kind === 'pc') {
    state.items = state.raw;
    return;
  }
  let items = state.raw.filter(
    (i) => i.type !== 'link' && (!i.system || winPrefs.showSystem) && (!i.hidden || showHidden()),
  );
  const { key, dir } = prefs.sort;
  const coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
  const cmp = {
    name: (a, b) => coll.compare(a.name, b.name),
    mtime: (a, b) => a.mtime - b.mtime || coll.compare(a.name, b.name),
    type: (a, b) => coll.compare(typeName(a), typeName(b)) || coll.compare(a.name, b.name),
    size: (a, b) => a.size - b.size || coll.compare(a.name, b.name),
    loc: (a, b) => coll.compare(a.path, b.path),
  }[key] || ((a, b) => coll.compare(a.name, b.name));
  items.sort((a, b) => {
    if (a.type !== b.type && key !== 'type') return a.type === 'dir' ? -1 : 1;
    return cmp(a, b) * dir;
  });
  state.items = items;
}

// ───────────────────────── 렌더링 ─────────────────────────
const COLUMNS = {
  details: [
    { key: 'name', label: '이름', w: 'minmax(220px, 3fr)' },
    { key: 'mtime', label: '수정한 날짜', w: 'minmax(150px, 1.2fr)' },
    { key: 'type', label: '유형', w: 'minmax(120px, 1.2fr)' },
    { key: 'size', label: '크기', w: '100px', num: true },
  ],
  search: [
    { key: 'name', label: '이름', w: 'minmax(200px, 2fr)' },
    { key: 'loc', label: '폴더', w: 'minmax(200px, 2fr)' },
    { key: 'mtime', label: '수정한 날짜', w: '150px' },
    { key: 'size', label: '크기', w: '90px', num: true },
  ],
};

function render() {
  renderChrome();
  const list = $('#list');
  const header = $('#list-header');
  list.replaceChildren();
  header.replaceChildren();
  $('#empty').hidden = true;

  if (state.loc.kind === 'pc') return renderPc(list, header);

  const cols = state.loc.kind === 'search' ? COLUMNS.search : COLUMNS.details;
  const isIcons = prefs.view === 'icons' && state.loc.kind === 'dir';
  list.className = isIcons ? 'icons' : 'details';
  header.classList.toggle('hidden', isIcons);
  document.documentElement.style.setProperty('--cols', cols.map((c) => c.w).join(' '));

  for (const c of cols) {
    const h = el('div', `col-h${c.num ? ' num' : ''}`);
    h.append(el('span', '', c.label));
    if (prefs.sort.key === c.key) h.append(el('span', 'arrow', prefs.sort.dir > 0 ? '' : ''));
    h.onclick = () => {
      prefs.sort = { key: c.key, dir: prefs.sort.key === c.key ? -prefs.sort.dir : 1 };
      savePrefs();
      applyItems();
      render();
    };
    header.append(h);
  }

  const clip = readClip();
  const cutSet = new Set(clip?.mode === 'cut' && clip.server === state.server ? clip.paths.map((p) => p.toLowerCase()) : []);
  const frag = document.createDocumentFragment();
  state.items.forEach((it, i) => {
    const row = el('div', 'row');
    row.dataset.i = i;
    row.draggable = true;
    if (state.selected.has(it.path)) row.classList.add('sel');
    if (i === state.focus) row.classList.add('focus');
    if (cutSet.has(it.path.toLowerCase()) || it.hidden) row.classList.add('cut');
    const name = el('div', 'cell name');
    const img = el('img');
    img.alt = '';
    setIcon(img, iconKeyOf(it), isIcons ? 'large' : 'small');
    name.append(img, el('span', '', displayName(it)));
    row.append(name);
    if (state.loc.kind === 'search') row.append(el('div', 'cell', parentOf(it.path)));
    row.append(el('div', 'cell', formatDate(it.mtime)));
    if (state.loc.kind !== 'search') row.append(el('div', 'cell', typeName(it)));
    row.append(el('div', 'cell num', it.type === 'file' ? formatSize(it.size) : ''));
    row.title = isIcons ? `${it.name}\n유형: ${typeName(it)}${it.type === 'file' ? `\n크기: ${formatBytes(it.size)}` : ''}\n수정한 날짜: ${formatDate(it.mtime)}` : '';
    frag.append(row);
  });
  list.append(frag);
  if (!state.items.length) {
    $('#empty').hidden = false;
    $('#empty').textContent = state.loc.kind === 'search' ? '검색 결과가 없습니다.' : '이 폴더는 비어 있습니다.';
  }
  renderStatus();
}

function renderPc(list, header) {
  list.className = 'pc';
  header.classList.add('hidden');
  const groups = [
    ['폴더', state.items.filter((i) => i.kind === 'known')],
    [`장치 및 드라이브`, state.items.filter((i) => i.kind === 'drive')],
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    list.append(el('div', 'group-title', `${title} (${items.length})`));
    const tiles = el('div', 'tiles');
    for (const it of items) {
      const i = state.items.indexOf(it);
      const t = el('div', `tile row${it.kind === 'known' ? ' small' : ''}`);
      t.dataset.i = i;
      if (state.selected.has(it.path)) t.classList.add('sel');
      if (i === state.focus) t.classList.add('focus');
      const img = el('img');
      setIcon(img, iconKeyOf(it), 'large');
      const info = el('div');
      info.append(el('div', 't-name', it.name));
      if (it.kind === 'drive' && it.drive.size) {
        const used = 1 - it.drive.free / it.drive.size;
        const bar = el('div', 'usage');
        const fill = el('span', used > 0.9 ? 'full' : '');
        fill.style.width = `${(used * 100).toFixed(1)}%`;
        bar.append(fill);
        info.append(bar, el('div', 't-sub', `${formatBytes(it.drive.size)} 중 ${formatBytes(it.drive.free)} 사용 가능`));
      } else if (it.kind === 'known') {
        info.append(el('div', 't-sub', '원격 PC'));
      }
      t.append(img, info);
      tiles.append(t);
    }
    list.append(tiles);
  }
  renderStatus();
}

function renderChrome() {
  const loc = state.loc;
  const title = loc.kind === 'pc' ? '내 PC' : loc.kind === 'search' ? `"${loc.q}" 검색 결과 - ${baseName(loc.path)}` : folderTitle(loc.path);
  $('#tab-title').textContent = title;
  window.rd.setTitle(`${title} - 파일 탐색기`);
  setIcon($('#tab-icon'), loc.kind === 'pc' ? 'drive:fixed' : loc.kind === 'dir' && isRoot(loc.path) ? 'drive:fixed' : 'folder', 'small');
  $('#btn-back').disabled = state.hIdx <= 0;
  $('#btn-fwd').disabled = state.hIdx >= state.history.length - 1;
  $('#btn-up').disabled = loc.kind === 'pc';
  $('#search-input').placeholder = `${loc.kind === 'pc' ? '내 PC' : baseName(loc.path)} 검색`;
  const inDir = loc.kind === 'dir';
  for (const id of ['#btn-new', '#btn-paste', '#btn-claude', '#btn-claude-more']) $(id).disabled = !inDir;
  renderCrumbs();
  renderSidebarActive();
}

function folderTitle(p) {
  if (isRoot(p)) {
    const d = state.drives.find((x) => x.path.toLowerCase() === normRoot(p).toLowerCase());
    return d ? driveLabel(d) : p;
  }
  return baseName(p);
}

function renderCrumbs() {
  const c = $('#crumbs');
  c.replaceChildren();
  const icon = el('img', 'crumb-icon');
  setIcon(icon, state.loc.kind === 'pc' ? 'drive:fixed' : 'folder', 'small');
  c.append(icon);
  const add = (label, loc) => {
    const s = el('span', 'crumb', label);
    s.onclick = (e) => {
      e.stopPropagation();
      navigate(loc);
    };
    c.append(s);
  };
  const sep = () => c.append(el('span', 'crumb-sep', ''));
  add('내 PC', { kind: 'pc' });
  if (state.loc.kind === 'pc') return;
  const p = state.loc.path;
  const parts = p.replace(/\\+$/, '').split('\\');
  let acc = '';
  parts.forEach((part, i) => {
    acc = i === 0 ? `${part}\\` : acc.endsWith('\\') ? acc + part : `${acc}\\${part}`;
    sep();
    add(i === 0 ? folderTitle(acc) : part, { kind: 'dir', path: acc });
  });
  if (state.loc.kind === 'search') {
    sep();
    c.append(el('span', 'crumb', `"${state.loc.q}" 검색 결과`));
  }
  requestAnimationFrame(() => (c.scrollLeft = c.scrollWidth));
}

function renderStatus() {
  const n = state.items.length;
  $('#status-count').textContent = `${n.toLocaleString('ko-KR')}개 항목`;
  const sel = state.items.filter((i) => state.selected.has(i.path));
  if (!sel.length) {
    $('#status-sel').textContent = '';
    return;
  }
  const files = sel.filter((i) => i.type === 'file');
  const size = files.length === sel.length ? ` ${formatBytes(files.reduce((a, b) => a + b.size, 0))}` : '';
  $('#status-sel').textContent = `${sel.length}개 항목 선택함${size}`;
}

function updateSelectionClasses() {
  for (const row of $('#list').querySelectorAll('.row')) {
    const i = Number(row.dataset.i);
    row.classList.toggle('sel', state.selected.has(state.items[i]?.path));
    row.classList.toggle('focus', i === state.focus);
  }
  renderStatus();
}

function scrollToFocus() {
  const row = $(`#list .row[data-i="${state.focus}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

// ───────────────────────── 사이드바 ─────────────────────────
function renderSidebar() {
  const sb = $('#sidebar');
  sb.replaceChildren();
  const item = (label, iconKey, loc, glyph, indent = 0, pinned = false) => {
    const d = el('div', 'side-item');
    d.style.setProperty('--indent', `${indent}px`);
    d.dataset.key = locKey(loc);
    if (loc.kind === 'dir') d.dataset.path = loc.path;
    if (glyph) d.append(el('span', 'glyph', glyph));
    else {
      const img = el('img');
      setIcon(img, iconKey, 'small');
      d.append(img);
    }
    d.append(el('span', '', label));
    if (pinned) d.append(el('span', 'pin', ''));
    d.onclick = () => navigate(loc);
    d.oncontextmenu = (e) => {
      e.preventDefault();
      if (loc.kind === 'dir') itemMenu([{ path: loc.path, name: label, type: 'dir' }], true);
    };
    sb.append(d);
  };
  const known = state.info?.knownFolders || [];
  if (state.quick) {
    for (const q of state.quick) {
      const k = known.find((k) => k.path.toLowerCase() === q.path.toLowerCase());
      item(k ? k.name : q.name, k ? `known:${k.id}` : 'folder', { kind: 'dir', path: q.path }, null, 0, q.pinned);
    }
  } else for (const k of known) item(k.name, `known:${k.id}`, { kind: 'dir', path: k.path });
  sb.append(el('div', 'side-sep'));
  item('내 PC', '', { kind: 'pc' }, '');
  for (const d of state.drives) item(driveLabel(d), `drive:${d.type}`, { kind: 'dir', path: d.path }, null, 20);
  renderSidebarActive();
}
async function loadQuickAccess() {
  const r = await call('GET', '/api/fs/quick');
  state.quick = r.ok ? r.data : null;
}
const quickOf = (p) => state.quick?.find((q) => q.path.toLowerCase() === p.toLowerCase());

async function setQuickAccess(it, pin) {
  const r = await call('POST', `/api/fs/quick/${pin ? 'pin' : 'unpin'}`, { body: { path: it.path } });
  if (!r.ok) return showError(r.data?.message || '즐겨찾기를 바꾸지 못했습니다', displayName(it));
  state.quick = r.data;
  renderSidebar();
}

function renderSidebarActive() {
  const key = locKey(state.loc);
  for (const d of document.querySelectorAll('.side-item')) d.classList.toggle('active', d.dataset.key === key);
}

// 사이드바 너비 조절
(() => {
  const sb = $('#sidebar');
  sb.style.width = `${prefs.sidebar}px`;
  $('#splitter').onmousedown = (e) => {
    const startX = e.clientX;
    const startW = sb.offsetWidth;
    const move = (ev) => (sb.style.width = `${Math.min(480, Math.max(140, startW + ev.clientX - startX))}px`);
    const up = () => {
      prefs.sidebar = sb.offsetWidth;
      savePrefs();
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
})();

// ───────────────────────── 선택 ─────────────────────────
const selectedItems = () => state.items.filter((i) => state.selected.has(i.path));

function selectIndex(i, { ctrl = false, shift = false } = {}) {
  if (i < 0 || i >= state.items.length) return;
  if (shift && state.anchor >= 0) {
    const [a, b] = [Math.min(state.anchor, i), Math.max(state.anchor, i)];
    if (!ctrl) state.selected.clear();
    for (let k = a; k <= b; k++) state.selected.add(state.items[k].path);
  } else if (ctrl) {
    const p = state.items[i].path;
    if (state.selected.has(p)) state.selected.delete(p);
    else state.selected.add(p);
    state.anchor = i;
  } else {
    state.selected = new Set([state.items[i].path]);
    state.anchor = i;
  }
  state.focus = i;
  updateSelectionClasses();
  scrollToFocus();
}

// ───────────────────────── 동작 ─────────────────────────
const currentDir = () => (state.loc.kind === 'dir' ? state.loc.path : null);

async function openItem(it, { newWindow = false } = {}) {
  if (it.type === 'dir') {
    if (newWindow) return window.rd.newWindow(it.path);
    return openDir(it.path);
  }
  if (extOf(it.name) === 'lnk') {
    const r = await call('GET', '/api/fs/shortcut', { query: { path: it.path } });
    if (!r.ok) return showError(r.data?.message || '바로 가기를 열 수 없습니다', displayName(it));
    return openItem(r.data, { newWindow });
  }
  await window.rd.openFile(it.path);
}

function openSelection() {
  const sel = selectedItems();
  const dir = sel.find((i) => i.type === 'dir');
  if (dir) return openItem(dir);
  sel.slice(0, 15).forEach((it) => openItem(it));
}

function readClip() {
  try {
    return JSON.parse(localStorage.getItem('rd-clip') || 'null');
  } catch {
    return null;
  }
}

async function setClip(mode, items) {
  if (!items.length) return;
  const paths = items.map((i) => i.path);
  const marker = paths.join('\r\n');
  try {
    localStorage.setItem('rd-clip', JSON.stringify({ mode, paths, marker, server: state.server }));
  } catch {
    /* 무시 */
  }
  await window.rd.writeText(marker);
  render();
}

async function paste(targetDir = currentDir()) {
  if (!targetDir) return;
  const localFiles = await window.rd.clipboardFiles();
  if (localFiles.length) {
    await window.rd.uploadPaths(localFiles, targetDir);
    return;
  }
  const clip = readClip();
  if (!clip || clip.server !== state.server) return;
  const text = await window.rd.readText();
  if (text !== clip.marker) return;
  const ok = await transfer(clip.paths, targetDir, clip.mode === 'cut');
  if (ok && clip.mode === 'cut') {
    localStorage.removeItem('rd-clip');
    await window.rd.writeText('');
  }
}

async function transfer(sources, destDir, move) {
  let body = { sources, destDir, move };
  let r = await call('POST', '/api/fs/transfer', { body });
  if (r.status === 409 && r.data?.code === 'ECONFLICT') {
    const mode = await window.rd.askConflict(r.data.conflicts);
    if (!mode) return false;
    r = await call('POST', '/api/fs/transfer', { body: { ...body, onConflict: mode } });
  }
  if (!r.ok) {
    await showError(r.data?.message || '작업을 완료할 수 없습니다', move ? '이동' : '복사');
    return false;
  }
  const items = r.data.items || [];
  if (items.length) window.rd.history.push(move ? { type: 'move', items } : { type: 'copy', paths: items.map((i) => i.dest) });
  await load({ selectPath: r.data.paths[0] && parentOf(r.data.paths[0])?.toLowerCase() === currentDir()?.toLowerCase() ? r.data.paths[0] : undefined });
  return true;
}

/** 휴지통으로 삭제 (실수로 지워도 Ctrl+Z로 되돌릴 수 있도록 영구 삭제는 두지 않는다) */
async function deleteSelection() {
  const sel = selectedItems().filter((i) => i.kind !== 'drive' && i.kind !== 'known');
  if (!sel.length) return;
  const idx = state.focus;
  const r = await call('POST', '/api/fs/delete', { body: { paths: sel.map((i) => i.path), permanent: false } });
  if (!r.ok) await showError(r.data?.message || '삭제할 수 없습니다', '삭제');
  else window.rd.history.push({ type: 'delete', paths: sel.map((i) => i.path) });
  await load();
  if (state.items.length && !state.selected.size) {
    const i = Math.min(idx, state.items.length - 1);
    state.focus = state.anchor = i;
    updateSelectionClasses();
  }
}

function startRename(it = selectedItems()[0], onDone) {
  if (!it || it.kind === 'drive' || it.kind === 'known' || state.loc.kind === 'pc') return false;
  const i = state.items.indexOf(it);
  const row = $(`#list .row[data-i="${i}"]`);
  if (!row) return false;
  state.renaming = true;
  const span = row.querySelector('.cell.name span');
  const input = el('input', 'rename-input');
  const hiddenExt = hidesExt(it) ? it.name.slice(it.name.lastIndexOf('.')) : '';
  input.value = displayName(it);
  input.spellcheck = false;
  span.replaceWith(input);
  row.draggable = false;
  input.focus();
  const dot = it.type === 'file' && !hiddenExt ? it.name.lastIndexOf('.') : -1;
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    state.renaming = false;
    const name = input.value.trim() + hiddenExt;
    if (commit && name !== hiddenExt && name !== it.name) {
      const r = await call('POST', '/api/fs/rename', { body: { path: it.path, name } });
      if (!r.ok) {
        onDone?.(it.path);
        await showError(r.data?.message || '이름을 바꿀 수 없습니다', '이름 바꾸기');
        render();
      } else {
        if (onDone) onDone(r.data.path);
        else window.rd.history.push({ type: 'rename', from: it.path, to: r.data.path });
        await load({ selectPath: r.data.path });
      }
    } else {
      onDone?.(it.path);
      render();
    }
    $('#view').focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onmousedown = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  return true;
}

async function createNew(kind) {
  const dir = currentDir();
  if (!dir) return;
  const r = await call('POST', kind === 'folder' ? '/api/fs/mkdir' : '/api/fs/newfile', { body: { dir } });
  if (!r.ok) return showError(r.data?.message || '만들 수 없습니다');
  await load({ selectPath: r.data.path });
  // 만들고 바로 붙인 이름까지 한 번의 '새로 만들기'로 기록한다
  const record = (p) => window.rd.history.push({ type: 'create', paths: [p] });
  if (!startRename(state.items.find((i) => i.path.toLowerCase() === r.data.path.toLowerCase()), record)) record(r.data.path);
}

// ───────────────────────── 실행 취소 / 다시 실행 ─────────────────────────
const OP_NAMES = { rename: '이름 바꾸기', create: '새로 만들기', copy: '복사', move: '이동', delete: '삭제' };

/** 각 항목을 src에서 dest로 옮긴다 (폴더가 다르면 이동 후, 이름이 다르면 이름 바꾸기) */
async function moveEach(pairs) {
  for (const { src, dest } of pairs) {
    const destDir = parentOf(dest);
    let cur = src;
    if (parentOf(src).toLowerCase() !== destDir.toLowerCase()) {
      const r = await call('POST', '/api/fs/transfer', { body: { sources: [src], destDir, move: true } });
      if (!r.ok) return r;
      cur = r.data.paths[0] || cur;
    }
    if (baseName(cur) !== baseName(dest)) {
      const r = await call('POST', '/api/fs/rename', { body: { path: cur, name: baseName(dest) } });
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

async function runHistory(which) {
  const op = await window.rd.history.take(which);
  if (!op) return;
  const undo = which === 'undo';
  let r;
  let select;
  if (op.type === 'rename') {
    const [from, to] = undo ? [op.to, op.from] : [op.from, op.to];
    r = await call('POST', '/api/fs/rename', { body: { path: from, name: baseName(to) } });
    select = to;
  } else if (op.type === 'move') {
    r = await moveEach(op.items.map(({ src, dest }) => (undo ? { src: dest, dest: src } : { src, dest })));
    select = undo ? op.items[0].src : op.items[0].dest;
  } else {
    // 복사·새로 만들기 취소는 휴지통으로 보내고, 삭제 취소(와 그 다시 실행)는 휴지통에서 되살린다
    const trash = (op.type === 'delete') !== undo;
    r = trash
      ? await call('POST', '/api/fs/delete', { body: { paths: op.paths, permanent: false } })
      : await call('POST', '/api/fs/restore', { body: { paths: op.paths } });
    if (!trash) select = op.paths[0];
    if (r.status === 404 && !r.data?.code) r.data = { message: '집 PC 서버가 휴지통 복원을 지원하지 않습니다. 서버를 최신 버전으로 업데이트하세요.' };
  }
  if (!r.ok) {
    await showError(r.data?.message || '작업을 완료할 수 없습니다', `${undo ? '실행 취소' : '다시 실행'} - ${OP_NAMES[op.type]}`);
    return load();
  }
  await window.rd.history.put(undo ? 'redo' : 'undo', op);
  await load({ selectPath: select && parentOf(select)?.toLowerCase() === currentDir()?.toLowerCase() ? select : undefined });
}

async function historyMenuItems() {
  const { undo, redo } = await window.rd.history.peek();
  return [
    ...(undo ? [{ id: 'undo', label: `실행 취소 - ${OP_NAMES[undo]}`, accelerator: 'Ctrl+Z' }] : []),
    ...(redo ? [{ id: 'redo', label: `다시 실행 - ${OP_NAMES[redo]}`, accelerator: 'Ctrl+Y' }] : []),
  ];
}

/** 속성 (Alt+Enter) — 선택이 없으면 현재 폴더 */
async function showProperties(items = selectedItems()) {
  if (!items.length && state.loc.kind === 'dir') items = [{ path: state.loc.path, name: baseName(state.loc.path), type: 'dir' }];
  if (!items.length) return;
  let lines;
  if (items.length === 1) {
    const it = items[0].kind ? items[0] : (await call('GET', '/api/fs/stat', { query: { path: items[0].path } })).data || items[0];
    if (it.kind === 'drive') {
      const d = it.drive;
      lines = [`종류: ${driveTypeName(d)}`, `사용 중인 공간: ${formatBytes(d.size - d.free)}`, `사용 가능한 공간: ${formatBytes(d.free)}`, `용량: ${formatBytes(d.size)}`];
    } else {
      lines = [
        `파일 형식: ${typeName(it)}`,
        `위치: ${parentOf(it.path) || it.path}`,
        ...(it.type === 'file' ? [`크기: ${formatBytes(it.size)} (${(it.size ?? 0).toLocaleString('ko-KR')} 바이트)`] : []),
        ...(it.ctime ? [`만든 날짜: ${formatDate(it.ctime)}`] : []),
        ...(it.mtime ? [`수정한 날짜: ${formatDate(it.mtime)}`] : []),
      ];
    }
  } else {
    const files = items.filter((i) => i.type === 'file');
    lines = [
      `파일 ${files.length}개, 폴더 ${items.length - files.length}개`,
      `위치: ${parentOf(items[0].path) || ''}`,
      `파일 크기 합계: ${formatBytes(files.reduce((a, b) => a + b.size, 0))}`,
    ];
  }
  const title = items.length === 1 ? displayName(items[0]) : `${items.length}개 항목`;
  await window.rd.message({ type: 'none', title: `${title} 속성`, message: title, detail: lines.join('\n'), buttons: ['확인'] });
}

async function copyPath(items) {
  const paths = (items.length ? items : state.loc.kind === 'dir' ? [{ path: state.loc.path }] : []).map((i) => `"${i.path}"`);
  if (paths.length) await window.rd.writeText(paths.join('\r\n'));
}

function openTerminal(kind, cwd = currentDir()) {
  if (!cwd) return;
  window.rd.openTerminal({ kind, cwd });
}

// ───────────────────────── 메뉴 ─────────────────────────
const SEP = { type: 'separator' };

function viewMenuItems() {
  return [
    { id: 'view:icons', label: '큰 아이콘', checked: prefs.view === 'icons' },
    { id: 'view:details', label: '자세히', checked: prefs.view === 'details' },
  ];
}
function sortMenuItems() {
  const k = prefs.sort.key;
  return [
    { id: 'sort:name', label: '이름', checked: k === 'name' },
    { id: 'sort:mtime', label: '수정한 날짜', checked: k === 'mtime' },
    { id: 'sort:type', label: '유형', checked: k === 'type' },
    { id: 'sort:size', label: '크기', checked: k === 'size' },
    SEP,
    { id: 'sort:asc', label: '오름차순', checked: prefs.sort.dir > 0 },
    { id: 'sort:desc', label: '내림차순', checked: prefs.sort.dir < 0 },
  ];
}
function newMenuItems() {
  return [
    { id: 'new:folder', label: '폴더', accelerator: 'Ctrl+Shift+N' },
    SEP,
    { id: 'new:text', label: '텍스트 문서' },
  ];
}
function terminalMenuItems(cwd) {
  return [
    { id: `term:claude`, label: '여기서 Claude Code 열기', enabled: !!cwd },
    { id: `term:claude-continue`, label: '이전 대화 이어서 열기 (--continue)', enabled: !!cwd },
    SEP,
    { id: `term:shell`, label: '터미널에서 열기', enabled: !!cwd },
  ];
}

async function handleMenu(id, ctx = {}) {
  if (!id) return;
  const [group, arg] = id.split(':');
  switch (group) {
    case 'view':
      prefs.view = arg;
      savePrefs();
      return render();
    case 'sort':
      if (arg === 'asc') prefs.sort.dir = 1;
      else if (arg === 'desc') prefs.sort.dir = -1;
      else prefs.sort = { key: arg, dir: 1 };
      savePrefs();
      applyItems();
      return render();
    case 'new':
      return createNew(arg === 'folder' ? 'folder' : 'text');
    case 'term':
      return openTerminal(arg, ctx.cwd ?? currentDir());
    case 'open':
      return arg === 'newwin' ? openItem(ctx.items[0], { newWindow: true }) : openSelection();
    case 'cut':
      return setClip('cut', ctx.items);
    case 'copy':
      return setClip('copy', ctx.items);
    case 'paste':
      return paste(ctx.cwd ?? currentDir());
    case 'rename':
      return startRename(ctx.items[0]);
    case 'delete':
      return deleteSelection();
    case 'copypath':
      return copyPath(ctx.items || []);
    case 'download':
      return window.rd.downloadEntries((ctx.items || []).map((i) => ({ path: i.path, name: i.name, type: i.type, size: i.size })));
    case 'refresh':
      return load();
    case 'hidden':
      prefs.showHidden = !showHidden();
      savePrefs();
      applyItems();
      return render();
    case 'newwin':
      return window.rd.newWindow(currentDir());
    case 'connect':
      return showHome(true);
    case 'undo':
    case 'redo':
      return runHistory(group);
    case 'props':
      return showProperties(ctx.items);
    case 'quick':
      return setQuickAccess(ctx.items[0], arg === 'pin');
    case 'attach':
      return window.rd.openTerminal({ sessionId: arg, kind: ctx.kind, cwd: ctx.cwd });
    case 'selectall':
      state.selected = new Set(state.items.map((i) => i.path));
      return updateSelectionClasses();
  }
}

async function itemMenu(items, fromSidebar = false) {
  const one = items.length === 1 ? items[0] : null;
  const isDir = one?.type === 'dir';
  const special = items.some((i) => i.kind === 'drive' || i.kind === 'known') || fromSidebar;
  const tpl = [
    { id: 'open', label: '열기' },
    ...(isDir ? [{ id: 'open:newwin', label: '새 창에서 열기' }] : []),
    SEP,
    ...(isDir ? [...terminalMenuItems(one.path), SEP] : []),
    ...(isDir && state.quick
      ? [quickOf(one.path)?.pinned ? { id: 'quick:unpin', label: '즐겨찾기에서 제거' } : { id: 'quick:pin', label: '즐겨찾기에 고정' }, SEP]
      : []),
    ...(special ? [] : [{ id: 'cut', label: '잘라내기', accelerator: 'Ctrl+X' }]),
    ...(special ? [] : [{ id: 'copy', label: '복사', accelerator: 'Ctrl+C' }]),
    ...(isDir ? [{ id: 'paste', label: '붙여넣기', accelerator: 'Ctrl+V' }] : []),
    SEP,
    ...(special ? [] : [{ id: 'rename', label: '이름 바꾸기', accelerator: 'F2', enabled: !!one }]),
    ...(special ? [] : [{ id: 'delete', label: '삭제', accelerator: 'Delete' }]),
    SEP,
    { id: 'download', label: '내 노트북에 저장...' },
    { id: 'copypath', label: '경로로 복사', accelerator: 'Ctrl+Shift+C' },
    SEP,
    { id: 'props', label: '속성', accelerator: 'Alt+Enter' },
  ];
  const id = await window.rd.menu(tidy(tpl));
  if (id === 'open' && fromSidebar) return openItem(one);
  handleMenu(id, { items, cwd: isDir ? one.path : undefined });
}

async function backgroundMenu() {
  const inDir = state.loc.kind === 'dir';
  const tpl = [
    { label: '보기', submenu: viewMenuItems() },
    { label: '정렬 기준', submenu: sortMenuItems() },
    { id: 'refresh', label: '새로 고침', accelerator: 'F5' },
    SEP,
    ...(inDir ? [{ id: 'paste', label: '붙여넣기', accelerator: 'Ctrl+V' }] : []),
    ...(await historyMenuItems()),
    SEP,
    ...(inDir ? [...terminalMenuItems(currentDir()), SEP] : []),
    ...(inDir ? [{ label: '새로 만들기', submenu: newMenuItems() }, SEP] : []),
    { id: 'copypath', label: '경로로 복사' },
    ...(inDir ? [SEP, { id: 'props', label: '속성', accelerator: 'Alt+Enter' }] : []),
  ];
  handleMenu(await window.rd.menu(tidy(tpl)), { items: [] });
}

function tidy(tpl) {
  const out = [];
  for (const it of tpl) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

async function moreMenu() {
  const sessions = (await call('GET', '/api/terminals')).data || [];
  const attached = new Set(await window.rd.attachedTerminals());
  const detached = sessions.filter((s) => !attached.has(s.id) && !s.exited);
  const tpl = [
    { id: 'newwin', label: '새 창', accelerator: 'Ctrl+N' },
    SEP,
    { id: 'hidden', label: '숨긴 항목 표시', checked: showHidden() },
    { id: 'selectall', label: '모두 선택', accelerator: 'Ctrl+A' },
    SEP,
    {
      label: '실행 중인 터미널',
      submenu: detached.length
        ? detached.map((s) => ({ id: `attach:${s.id}`, label: `${s.kind === 'shell' ? 'PowerShell' : 'Claude Code'} — ${s.cwd}` }))
        : [{ label: '분리된 세션 없음', enabled: false }],
    },
    SEP,
    { id: 'connect', label: '다른 PC 선택...' },
  ];
  const id = await window.rd.menu(tpl);
  const s = id?.startsWith('attach:') ? detached.find((x) => x.id === id.slice(7)) : null;
  handleMenu(id, s ? { kind: s.kind, cwd: s.cwd } : {});
}

// ───────────────────────── 이벤트: 목록 ─────────────────────────
const list = $('#list');
const rowIndex = (target) => {
  const row = target.closest('.row');
  return row ? Number(row.dataset.i) : -1;
};

list.addEventListener('mousedown', (e) => {
  if (state.renaming) return;
  if (e.button === 3 || e.button === 4) return;
  $('#view').focus();
  const i = rowIndex(e.target);
  if (i < 0) {
    if (e.button === 0) {
      if (!e.ctrlKey && !e.shiftKey) {
        state.selected.clear();
        updateSelectionClasses();
      }
      startMarquee(e);
    } else if (e.button === 2) {
      state.selected.clear();
      updateSelectionClasses();
    }
    return;
  }
  const p = state.items[i].path;
  if (e.button === 2) {
    if (!state.selected.has(p)) selectIndex(i);
    return;
  }
  if (e.button === 0 && state.selected.has(p) && !e.ctrlKey && !e.shiftKey) {
    // 드래그를 위해 다중 선택 유지 — mouseup 때 단일 선택으로
    state.focus = i;
    list.dataset.pending = String(i);
    return;
  }
  selectIndex(i, { ctrl: e.ctrlKey, shift: e.shiftKey });
});
list.addEventListener('mouseup', (e) => {
  const pending = list.dataset.pending;
  delete list.dataset.pending;
  if (pending !== undefined && e.button === 0 && rowIndex(e.target) === Number(pending)) selectIndex(Number(pending));
});
list.addEventListener('dblclick', (e) => {
  const i = rowIndex(e.target);
  if (i >= 0 && !state.renaming) openItem(state.items[i]);
});
list.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const i = rowIndex(e.target);
  if (i >= 0) itemMenu(selectedItems());
  else backgroundMenu();
});
list.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (state.loc.kind !== 'dir') return;
    const view = e.deltaY < 0 ? 'icons' : 'details';
    if (prefs.view !== view) handleMenu(`view:${view}`);
  },
  { passive: false },
);
document.addEventListener('mouseup', (e) => {
  if (e.button === 3) goBack();
  if (e.button === 4) goForward();
});

// 사각형 드래그 선택
function startMarquee(e) {
  if (state.loc.kind === 'pc') return;
  const box = el('div', 'marquee');
  const origin = list.getBoundingClientRect();
  const sx = e.clientX - origin.left + list.scrollLeft;
  const sy = e.clientY - origin.top + list.scrollTop;
  const base = new Set(e.ctrlKey ? state.selected : []);
  let shown = false;
  const move = (ev) => {
    const x = ev.clientX - origin.left + list.scrollLeft;
    const y = ev.clientY - origin.top + list.scrollTop;
    const [l, t, w, h] = [Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)];
    if (!shown && w + h < 4) return;
    if (!shown) list.append(box), (shown = true);
    Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
    const sel = new Set(base);
    for (const row of list.querySelectorAll('.row')) {
      const r = row.offsetTop;
      const rl = row.offsetLeft;
      if (r + row.offsetHeight > t && r < t + h && rl + row.offsetWidth > l && rl < l + w) sel.add(state.items[row.dataset.i].path);
    }
    state.selected = sel;
    updateSelectionClasses();
  };
  const up = () => {
    box.remove();
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// ───────────────────────── 드래그 앤 드롭 ─────────────────────────
let dragPaths = null;
list.addEventListener('dragstart', (e) => {
  const i = rowIndex(e.target);
  if (i < 0 || state.loc.kind === 'pc') return e.preventDefault();
  if (!state.selected.has(state.items[i].path)) selectIndex(i);
  dragPaths = selectedItems().map((x) => x.path);
  e.dataTransfer.setData('application/x-rd-paths', JSON.stringify(dragPaths));
  e.dataTransfer.effectAllowed = 'copyMove';
});
list.addEventListener('dragend', () => (dragPaths = null));

function dropTargetOf(e) {
  const side = e.target.closest('.side-item');
  if (side?.dataset.path) return { el: side, dir: side.dataset.path };
  const i = rowIndex(e.target);
  const it = i >= 0 ? state.items[i] : null;
  if (it && it.type === 'dir' && !(dragPaths || []).includes(it.path)) return { el: e.target.closest('.row'), dir: it.path };
  if (e.target.closest('#view') && currentDir()) return { el: null, dir: currentDir() };
  return null;
}
let lastDrop = null;
function markDrop(t) {
  if (lastDrop && lastDrop !== t?.el) lastDrop.classList.remove('drop');
  lastDrop = t?.el || null;
  lastDrop?.classList.add('drop');
}
for (const zone of [$('#view'), $('#sidebar')]) {
  zone.addEventListener('dragover', (e) => {
    const t = dropTargetOf(e);
    if (!t) return markDrop(null);
    e.preventDefault();
    const internal = e.dataTransfer.types.includes('application/x-rd-paths');
    if (internal) {
      const crossDrive = dragPaths && !sameDrive(dragPaths[0], t.dir);
      e.dataTransfer.dropEffect = e.ctrlKey || crossDrive ? 'copy' : e.shiftKey ? 'move' : 'move';
      if (!t.el && dragPaths && parentOf(dragPaths[0])?.toLowerCase() === t.dir.toLowerCase()) e.dataTransfer.dropEffect = 'none';
    } else e.dataTransfer.dropEffect = 'copy';
    markDrop(t);
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) markDrop(null);
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    markDrop(null);
    const t = dropTargetOf(e);
    if (!t) return;
    const internal = e.dataTransfer.getData('application/x-rd-paths');
    if (internal) {
      const paths = JSON.parse(internal);
      if (!t.el && parentOf(paths[0])?.toLowerCase() === t.dir.toLowerCase()) return;
      const move = !e.ctrlKey && sameDrive(paths[0], t.dir);
      await transfer(paths, t.dir, move);
      return;
    }
    const files = [...e.dataTransfer.files].map((f) => window.rd.pathForFile(f)).filter(Boolean);
    if (files.length) await window.rd.uploadPaths(files, t.dir);
  });
}

// ───────────────────────── 키보드 ─────────────────────────
let typeBuf = '';
let typeTimer = null;

function columnsPerRow() {
  if (list.className !== 'icons') return 1;
  const rows = list.querySelectorAll('.row');
  if (rows.length < 2) return 1;
  const top = rows[0].offsetTop;
  let n = 0;
  for (const r of rows) {
    if (r.offsetTop !== top) break;
    n++;
  }
  return Math.max(1, n);
}

document.addEventListener('keydown', (e) => {
  if (overlayOpen() || !$('#modal').hidden) return; // PC 선택 화면·대화상자는 자체 키 처리
  const inField = e.target.tagName === 'INPUT';
  const k = e.key;
  const ctrl = e.ctrlKey;

  // 전역 단축키
  if ((ctrl && k.toLowerCase() === 'l') || (e.altKey && k.toLowerCase() === 'd') || k === 'F4') return e.preventDefault(), editAddress();
  if ((ctrl && (k.toLowerCase() === 'f' || k.toLowerCase() === 'e')) || k === 'F3') return e.preventDefault(), $('#search-input').focus();
  if (ctrl && !e.shiftKey && k.toLowerCase() === 'n') return e.preventDefault(), window.rd.newWindow(currentDir());
  if (ctrl && k.toLowerCase() === 'w') return e.preventDefault(), window.close();
  if (e.altKey && k === 'ArrowLeft') return e.preventDefault(), goBack();
  if (e.altKey && k === 'ArrowRight') return e.preventDefault(), goForward();
  if (e.altKey && k === 'ArrowUp') return e.preventDefault(), goUp();
  if (k === 'F5' || (ctrl && k.toLowerCase() === 'r')) return e.preventDefault(), load();
  // 보기 전환: Ctrl+Shift+2 큰 아이콘 / Ctrl+Shift+6 자세히
  if (ctrl && e.shiftKey && (e.code === 'Digit2' || e.code === 'Digit6')) return e.preventDefault(), handleMenu(e.code === 'Digit2' ? 'view:icons' : 'view:details');
  if (inField || state.renaming) return;

  const n = state.items.length;
  const cur = state.focus;
  const step = (d) => {
    e.preventDefault();
    const next = cur < 0 ? 0 : Math.max(0, Math.min(n - 1, cur + d));
    if (ctrl && !e.shiftKey) {
      state.focus = next;
      updateSelectionClasses();
      scrollToFocus();
    } else selectIndex(next, { shift: e.shiftKey });
  };
  const perRow = columnsPerRow();
  const pageRows = Math.max(1, Math.floor(list.clientHeight / 28) - 1);

  switch (true) {
    case k === 'ArrowDown': return step(perRow);
    case k === 'ArrowUp': return step(-perRow);
    case k === 'ArrowRight' && perRow > 1: return step(1);
    case k === 'ArrowLeft' && perRow > 1: return step(-1);
    case k === 'PageDown': return step(pageRows * perRow);
    case k === 'PageUp': return step(-pageRows * perRow);
    case k === 'Home': return step(-n);
    case k === 'End': return step(n);
    case k === ' ' && ctrl: e.preventDefault(); return cur >= 0 && selectIndex(cur, { ctrl: true });
    case k === 'Enter' && e.altKey: e.preventDefault(); return showProperties();
    case k === 'Enter' && ctrl: {
      e.preventDefault();
      const dir = selectedItems().find((i) => i.type === 'dir');
      return dir ? openItem(dir, { newWindow: true }) : openSelection();
    }
    case k === 'Enter': e.preventDefault(); return openSelection();
    case k === 'ContextMenu' || (e.shiftKey && k === 'F10'):
      e.preventDefault();
      return state.selected.size ? itemMenu(selectedItems()) : backgroundMenu();
    case k === 'Backspace': e.preventDefault(); return goUp();
    case k === 'Delete': e.preventDefault(); return deleteSelection();
    case ctrl && k.toLowerCase() === 'd': e.preventDefault(); return deleteSelection();
    case ctrl && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z')): e.preventDefault(); return runHistory('redo');
    case ctrl && k.toLowerCase() === 'z': e.preventDefault(); return runHistory('undo');
    case ctrl && k === 'Insert': e.preventDefault(); return state.loc.kind !== 'pc' && setClip('copy', selectedItems());
    case e.shiftKey && k === 'Insert': e.preventDefault(); return paste();
    case k === 'F2': e.preventDefault(); return startRename();
    case ctrl && k.toLowerCase() === 'a': e.preventDefault(); return handleMenu('selectall');
    case ctrl && e.shiftKey && k.toLowerCase() === 'c': e.preventDefault(); return copyPath(selectedItems());
    case ctrl && k.toLowerCase() === 'c': e.preventDefault(); return state.loc.kind !== 'pc' && setClip('copy', selectedItems());
    case ctrl && k.toLowerCase() === 'x': e.preventDefault(); return state.loc.kind !== 'pc' && setClip('cut', selectedItems());
    case ctrl && k.toLowerCase() === 'v': e.preventDefault(); return paste();
    case ctrl && e.shiftKey && k.toLowerCase() === 'n': e.preventDefault(); return createNew('folder');
    case k === 'Escape':
      if (readClip()?.mode === 'cut') {
        localStorage.removeItem('rd-clip');
        render();
      }
      return;
  }
  // 이름 첫 글자로 이동
  if (k.length === 1 && !ctrl && !e.altKey && !e.metaKey) {
    typeBuf += k.toLowerCase();
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => (typeBuf = ''), 800);
    const start = typeBuf.length === 1 ? cur + 1 : Math.max(cur, 0);
    for (let d = 0; d < n; d++) {
      const i = (start + d) % n;
      if (displayName(state.items[i]).toLowerCase().startsWith(typeBuf)) return selectIndex(i);
    }
  }
});

// ───────────────────────── 주소 표시줄 / 검색 ─────────────────────────
function editAddress() {
  const a = $('#address');
  const input = $('#address-input');
  a.classList.add('editing');
  input.value = state.loc.kind === 'pc' ? '내 PC' : state.loc.path;
  input.focus();
  input.select();
}
$('#address').addEventListener('click', (e) => {
  if (!e.target.closest('.crumb')) editAddress();
});
$('#address-input').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') return e.target.blur();
  if (e.key !== 'Enter') return;
  let v = e.target.value.trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
  e.target.blur();
  if (!v || v === '내 PC') return navigate({ kind: 'pc' });
  if (v === '~' || v.startsWith('~\\')) v = state.info.home + v.slice(1);
  const known = state.info?.knownFolders.find((k) => k.name === v);
  if (known) v = known.path;
  if (/^[A-Za-z]:$/.test(v)) v += '\\';
  if (!/^[A-Za-z]:\\/.test(v) && state.loc.kind === 'dir') v = `${state.loc.path.replace(/\\$/, '')}\\${v}`;
  const r = await call('GET', '/api/fs/stat', { query: { path: v } });
  if (r.ok && r.data.type === 'dir') return openDir(r.data.path);
  if (r.ok && r.data.type === 'file') return window.rd.openFile(r.data.path);
  showError(`'${v}'을(를) 찾을 수 없습니다. 철자를 확인하고 다시 시도하세요.`);
});
$('#address-input').addEventListener('blur', () => $('#address').classList.remove('editing'));

$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    if (state.loc.kind === 'search') navigate({ kind: 'dir', path: state.loc.path });
    $('#view').focus();
    return;
  }
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  const root = state.loc.kind === 'search' ? state.loc.path : currentDir();
  if (!root) return;
  if (!q) return navigate({ kind: 'dir', path: root });
  navigate({ kind: 'search', path: root, q });
});

// ───────────────────────── 버튼 ─────────────────────────
const menuAt = async (items, ctx = {}) => handleMenu(await window.rd.menu(items), ctx);
$('#btn-back').onclick = goBack;
$('#btn-fwd').onclick = goForward;
$('#btn-up').onclick = goUp;
$('#btn-refresh').onclick = () => load();
$('#btn-newwin').onclick = () => window.rd.newWindow(currentDir());
$('#btn-new').onclick = () => menuAt(newMenuItems());
$('#btn-cut').onclick = () => setClip('cut', selectedItems());
$('#btn-copy').onclick = () => setClip('copy', selectedItems());
$('#btn-paste').onclick = () => paste();
$('#btn-rename').onclick = () => startRename();
$('#btn-delete').onclick = () => deleteSelection();
$('#btn-sort').onclick = () => menuAt(sortMenuItems());
$('#btn-view').onclick = () => menuAt(viewMenuItems());
$('#btn-more').onclick = moreMenu;
$('#btn-claude').onclick = () => {
  const sel = selectedItems();
  openTerminal('claude', sel.length === 1 && sel[0].type === 'dir' ? sel[0].path : currentDir());
};
$('#btn-claude-more').onclick = () => menuAt(terminalMenuItems(currentDir()));

// ───────────────────────── 토스트 / 진행률 ─────────────────────────
function toast(text, kind = 'ok', { ms = 3500, action, onAction } = {}) {
  const t = el('div', `toast${kind === 'error' ? ' error' : ''}`, text);
  if (action) {
    const b = el('button', 'act', action);
    b.onclick = () => {
      t.remove();
      onAction();
    };
    t.append(b);
  }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
window.rd.onToast(({ text, kind }) => toast(text, kind));
const progress = new Map();
window.rd.onProgress((p) => {
  if (p.done) progress.delete(p.id);
  else progress.set(p.id, p);
  const cur = [...progress.values()].pop();
  $('#status-progress').hidden = !cur;
  if (cur) {
    $('#status-progress-text').textContent = cur.text;
    $('#status-progress .bar > span').style.width = `${Math.round((cur.value || 0) * 100)}%`;
  }
});
window.rd.onFsChanged(({ dir }) => {
  if (currentDir()?.toLowerCase() === dir?.toLowerCase()) load({ silent: true });
});

// 다른 프로그램(Claude Code 등)이 바꾼 내용을 자동 반영
setInterval(() => {
  if (document.visibilityState !== 'visible' || state.renaming || state.loading) return;
  if (state.loc.kind === 'dir') load({ silent: true });
  else if (!state.connected) call('GET', '/api/info');
}, 2500);


// ───────────────────────── PC 선택 / 연결 ─────────────────────────
let pcs = []; // 등록된 PC
// id -> { state: checking|online|partial|offline|unknown|connecting|waking, text, shutdownAt }
const pcStatus = new Map();
const PC_STATUS = {
  checking: '확인 중...',
  online: '켜짐',
  partial: '켜짐 · 서버 꺼짐',
  offline: '꺼짐',
  unknown: '응답 없음',
  connecting: '연결 중...',
  waking: '켜는 중...',
};
let homeCancelable = false;
let renamingPc = null;
let probeTimer = null;
let retryTimer = null;
let wwFile = null; // 비밀번호 입력을 기다리는 WireWOL 설정 파일
let tunnelState = { state: 'checking', message: '', hasConf: false };

const overlayOpen = () => !$('#connect').hidden;
const addrOf = (server) => server.replace(/^https?:\/\//, '');
const timeLabel = (ms) => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function homeMessage(text, info = false) {
  $('#home-msg').textContent = text;
  $('#home-msg').classList.toggle('info', info);
}
function connectMessage(text, info = false) {
  $('#connect-error').textContent = text;
  $('#connect-error').classList.toggle('info', info);
}
function stopRetry() {
  clearTimeout(retryTimer);
  retryTimer = null;
}
function hideConnect() {
  stopRetry();
  clearInterval(probeTimer);
  probeTimer = null;
  $('#connect').hidden = true;
  if (state.info) renderChrome();
  $('#view').focus();
}
/** #connect 안의 화면 하나만 보이게 */
function showView(id) {
  $('#connect').hidden = false;
  for (const v of ['#home-view', '#add-view', '#settings-view', '#pair-view']) $(v).hidden = v !== id;
}

// ── 와이어가드 상태 줄 ──
function renderTunnel() {
  const t = tunnelState;
  const line = $('#wg-line');
  const action = $('#wg-action');
  const [cls, text, act] = {
    noconf: ['', 'WireGuard 설정 없음 — 집 밖에서 접속하려면 WireWOL 설정에서 등록하세요', '설정'],
    notinstalled: ['warn', '내장 WireGuard를 처음 한 번 설치해야 합니다 (관리자 권한 필요)', '설치'],
    direct: ['up', 'PC에 바로 연결됩니다 — WireGuard 필요 없음', ''],
    starting: ['warn', t.message || 'WireGuard 연결 중...', ''],
    up: ['up', 'WireGuard 연결됨 — 프로그램을 끝낼 때 함께 꺼집니다', ''],
    error: ['error', `WireGuard 오류: ${t.message}`, '다시 시도'],
  }[t.state] || ['', 'WireGuard 확인 중...', ''];
  line.className = cls;
  $('#wg-text').textContent = text;
  action.hidden = !act;
  action.textContent = act;
}
window.rd.onTunnel((t) => {
  tunnelState = t;
  renderTunnel();
  if (!$('#settings-view').hidden) renderSettings();
});
$('#wg-action').onclick = async () => {
  if (tunnelState.state === 'noconf') return showSettings();
  if (tunnelState.state === 'notinstalled') {
    const r = await window.rd.tunnel.install();
    if (!r.ok && !r.cancelled) homeMessage(r.message);
    return;
  }
  window.rd.tunnel.ensure();
};

/** 시작 화면: 등록된 PC 목록. cancelable이면 탐색 중에 열어 닫고 돌아갈 수 있다 */
async function showHome(cancelable = homeCancelable) {
  homeCancelable = cancelable;
  stopRetry();
  showView('#home-view');
  $('#connect').classList.toggle('start', !cancelable);
  $('#home-actions').hidden = !cancelable;
  window.rd.setTitle('원격 PC 선택 - 파일 탐색기');
  homeMessage('');
  tunnelState = await window.rd.tunnel.get();
  renderTunnel();
  pcs = await window.rd.pcs.list();
  if (!pcs.length) return showAdd();
  renderPcs();
  const { server } = await window.rd.connection.get();
  ($(`#pc-list .pc-card[data-server="${CSS.escape(server || '')}"]`) || $('#pc-list .pc-card'))?.focus();
  probeAll();
  clearInterval(probeTimer);
  probeTimer = setInterval(probeAll, 5000);
}

function renderPcs() {
  if (renamingPc) return;
  const list = $('#pc-list');
  const focused = document.activeElement?.closest?.('#pc-list .pc-card');
  const focusKey = focused?.dataset.id ?? (focused ? 'add' : null);
  list.replaceChildren();
  for (const pc of pcs) {
    const st = pcStatus.get(pc.id) || { state: 'checking' };
    const cls = ['online', 'partial', 'offline', 'unknown'].includes(st.state) ? st.state : 'busy';
    const t = el('div', `pc-card ${cls}`);
    t.tabIndex = 0;
    t.dataset.id = pc.id;
    t.dataset.server = pc.server;
    t.title = st.text || '';
    const info = el('div', 'pc-info');
    const sub = el('div', 'pc-sub');
    sub.append(el('span', 'dot'), el('span', '', PC_STATUS[st.state]));
    info.append(el('div', 'pc-name', pc.name), sub, el('div', 'pc-sub pc-addr', addrOf(pc.server)));
    if (st.shutdownAt) info.append(el('div', 'pc-sub pc-sched', `${timeLabel(st.shutdownAt)} 종료 예약`));
    t.append(el('i', '', ''), info);
    if ((st.state === 'offline' || st.state === 'unknown') && pc.mac) {
      const wake = el('button', 'pc-wake', 'PC 켜기');
      wake.onclick = (e) => {
        e.stopPropagation();
        wakePc(pc);
      };
      t.append(wake);
    }
    const more = el('button', 'pc-more');
    more.title = '더 보기';
    more.append(el('i', '', ''));
    more.onclick = (e) => {
      e.stopPropagation();
      pcMenu(pc);
    };
    t.append(more);
    t.onclick = () => connectPc(pc);
    t.oncontextmenu = (e) => {
      e.preventDefault();
      pcMenu(pc);
    };
    t.onkeydown = (e) => {
      if (e.target !== t) return;
      if (e.key === 'Enter' || e.key === ' ') return e.preventDefault(), connectPc(pc);
      if (e.key === 'F2') return e.preventDefault(), renamePc(pc);
      if (e.key === 'Delete') return e.preventDefault(), removePc(pc);
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) return e.preventDefault(), pcMenu(pc);
      tileNav(e, t);
    };
    list.append(t);
  }
  const add = el('div', 'pc-card add');
  add.tabIndex = 0;
  add.append(el('i', '', ''), el('span', '', 'PC 추가'));
  add.onclick = () => showAdd();
  add.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') return e.preventDefault(), showAdd();
    tileNav(e, add);
  };
  list.append(add);
  if (focusKey) (focusKey === 'add' ? add : list.querySelector(`.pc-card[data-id="${focusKey}"]`))?.focus();
}

/** 방향키로 카드 사이 이동 (2열 격자) */
function tileNav(e, tile) {
  const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2, Home: -999, End: 999 }[e.key];
  if (!d) return;
  e.preventDefault();
  const tiles = [...$('#pc-list').children];
  tiles[Math.max(0, Math.min(tiles.length - 1, tiles.indexOf(tile) + d))].focus();
}

/** pcs.status 결과 → 카드 상태. 서버가 응답하면 켜짐, 컴패니언만 응답하면 서버 꺼짐,
 *  둘 다 없으면 와이어가드가 필요한 상황(집 밖인데 아직 안 켜짐)인지에 따라 응답 없음/꺼짐 */
function statusOf(r) {
  if (r.server.ok) return { state: 'online', shutdownAt: r.shutdownAt };
  if (r.companion) return { state: 'partial', shutdownAt: r.shutdownAt, text: 'PC는 켜져 있지만 RemoteFileManager Server가 응답하지 않습니다' };
  const needTunnel = tunnelState.hasConf && !['up', 'direct'].includes(r.tunnel);
  return { state: needTunnel ? 'unknown' : 'offline', text: needTunnel ? '집 밖이라면 WireGuard를 켜야 확인됩니다' : r.server.message };
}

async function probeAll() {
  const busy = (id) => ['connecting', 'waking'].includes(pcStatus.get(id)?.state);
  await Promise.all(
    pcs.map(async (pc) => {
      if (busy(pc.id)) return;
      const r = await window.rd.pcs.status(pc.id);
      if (!r) return;
      if (r.server.ok) pc.name = r.name;
      if (!busy(pc.id)) pcStatus.set(pc.id, statusOf(r));
    }),
  );
  if (overlayOpen() && !$('#home-view').hidden) renderPcs();
}

function setPcStatus(pc, st, text) {
  pcStatus.set(pc.id, { ...pcStatus.get(pc.id), state: st, text });
  renderPcs();
}

/** 연결: 서버에 바로 → 안 되면 와이어가드 확보 후 다시 → 그래도 안 되면 꺼진 PC는 켜고 켜질 때까지 기다린다 */
async function connectPc(pc) {
  if (renamingPc || ['connecting', 'waking'].includes(pcStatus.get(pc.id)?.state)) return;
  stopRetry();
  homeMessage('');
  setPcStatus(pc, 'connecting');
  // 꺼진 PC에 바로 연결을 시도하면 TCP 시간 초과까지 오래 걸리므로 짧은 상태 확인부터 한다
  let st = await window.rd.pcs.status(pc.id);
  if (!st.server.ok && tunnelState.hasConf && tunnelState.state !== 'up') {
    homeMessage('PC에 바로 닿지 않아 WireGuard를 켜는 중...', true);
    tunnelState = await window.rd.tunnel.ensure();
    renderTunnel();
    if (tunnelState.state === 'notinstalled') {
      setPcStatus(pc, 'unknown');
      return homeMessage('집 밖에서 접속하려면 위의 [설치]로 내장 WireGuard를 먼저 설치하세요');
    }
    if (tunnelState.state === 'up') st = await window.rd.pcs.status(pc.id);
  }
  const r = st.server.ok ? await window.rd.connection.connect(pc.server) : { ok: false, message: st.server.message || '원격 PC 서버가 응답하지 않습니다' };
  if (r.ok) {
    hideConnect();
    return start(r.info, r.server);
  }
  if (st.server.ok) {
    setPcStatus(pc, 'online');
    return homeMessage(`${pc.name}: ${r.message}`);
  }
  if (st.companion) {
    setPcStatus(pc, 'partial');
    return homeMessage(`${pc.name}: PC는 켜져 있지만 RemoteFileManager Server가 실행 중이 아닙니다`);
  }
  if (pc.mac) return wakePc(pc, `${pc.name}이(가) 꺼져 있어 켜는 중입니다`);
  setPcStatus(pc, statusOf(st).state, r.message);
  homeMessage(`${pc.name}: ${r.message} — PC를 켜려면 PC 메뉴의 WireWOL 연결 정보에서 MAC 주소를 입력하세요`);
}

/** PC 켜기 후 켜질 때까지 대기: 처음 15초는 1초 간격, 이후 5초 간격(WireWOL과 같음), 최대 3분 */
async function wakePc(pc, intro) {
  stopRetry();
  setPcStatus(pc, 'waking');
  const r = await window.rd.pcs.wake(pc.id);
  if (!r.ok) {
    setPcStatus(pc, 'offline');
    return homeMessage(r.message);
  }
  homeMessage(`${intro || `${pc.name}에 켜기 신호를 보냈습니다`} — PC가 켜지고 서버가 시작되면 자동으로 연결합니다${r.note ? ` (${r.note})` : ''}`, true);
  const started = Date.now();
  const poll = async () => {
    if (!overlayOpen() || pcStatus.get(pc.id)?.state !== 'waking') return stopRetry();
    const st = await window.rd.pcs.status(pc.id);
    const res = st?.server.ok ? await window.rd.connection.connect(pc.server) : { ok: false };
    if (!retryTimer) return;
    if (res.ok) {
      stopRetry();
      hideConnect();
      return start(res.info, res.server);
    }
    const elapsed = Date.now() - started;
    if (elapsed > 180000) {
      stopRetry();
      setPcStatus(pc, 'offline');
      return homeMessage(`${pc.name}이(가) 3분 안에 응답하지 않았습니다. PC 전원과 서버 자동 실행 설정을 확인하세요.`);
    }
    retryTimer = setTimeout(poll, elapsed < 15000 ? 1000 : 5000);
  };
  retryTimer = setTimeout(poll, 1000);
}

async function pcMenu(pc) {
  const st = pcStatus.get(pc.id) || {};
  const on = st.state === 'online' || st.state === 'partial';
  const id = await window.rd.menu([
    { id: 'connect', label: '연결' },
    SEP,
    { id: 'wake', label: 'PC 켜기', enabled: !!pc.mac },
    { id: 'off', label: 'PC 끄기', enabled: on },
    { id: 'cancel', label: '종료 예약 취소', enabled: !!st.shutdownAt },
    SEP,
    { id: 'rename', label: '이름 바꾸기', accelerator: 'F2' },
    { id: 'pairing', label: 'WireWOL 연결 정보...' },
    { id: 'remove', label: '목록에서 삭제', accelerator: 'Delete' },
  ]);
  if (id === 'connect') connectPc(pc);
  else if (id === 'wake') wakePc(pc);
  else if (id === 'off') {
    if (await powerOff(pc)) probeAll();
  } else if (id === 'cancel') {
    const r = await window.rd.pcs.cancelShutdown(pc.id);
    homeMessage(r.ok ? `${pc.name}의 종료 예약을 취소했습니다` : r.message, r.ok);
    probeAll();
  } else if (id === 'rename') renamePc(pc);
  else if (id === 'pairing') showPairing(pc);
  else if (id === 'remove') removePc(pc);
}

function renamePc(pc) {
  const t = $(`#pc-list .pc-card[data-id="${pc.id}"]`);
  if (!t) return;
  renamingPc = pc.id;
  const input = el('input');
  input.value = pc.name;
  input.spellcheck = false;
  t.querySelector('.pc-name').replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    renamingPc = null;
    if (commit && input.value.trim() && input.value.trim() !== pc.name) {
      await window.rd.pcs.rename(pc.id, input.value);
      pcs = await window.rd.pcs.list();
    }
    renderPcs();
    $(`#pc-list .pc-card[data-id="${pc.id}"]`)?.focus();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

async function removePc(pc) {
  const { response } = await window.rd.message({
    type: 'warning',
    title: 'PC 삭제',
    message: `'${pc.name}'을(를) 목록에서 삭제하시겠습니까?`,
    detail: '원격 PC의 파일은 지워지지 않으며, 언제든 다시 추가할 수 있습니다. 이 PC의 WireWOL 연결 정보도 함께 지워집니다.',
    buttons: ['삭제', '취소'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  await window.rd.pcs.remove(pc.id);
  pcStatus.delete(pc.id);
  pcs = await window.rd.pcs.list();
  if (!pcs.length) return showAdd();
  renderPcs();
  $('#pc-list .pc-card')?.focus();
}

// ── PC별 WireWOL 연결 정보 ──
let pairingPc = null;
async function showPairing(pc) {
  pairingPc = pc;
  const p = await window.rd.pcs.getPairing(pc.id);
  showView('#pair-view');
  $('#pair-name').textContent = `— ${pc.name}`;
  $('#pair-mac').value = p.mac;
  $('#pair-host').value = p.host;
  $('#pair-port').value = p.port;
  $('#pair-token').value = p.token;
  $('#pair-msg').textContent = '';
  $('#pair-mac').focus();
}
async function savePairing() {
  const r = await window.rd.pcs.setPairing(pairingPc.id, {
    mac: $('#pair-mac').value,
    host: $('#pair-host').value,
    port: $('#pair-port').value,
    token: $('#pair-token').value,
  });
  if (!r.ok) return ($('#pair-msg').textContent = r.message);
  pcStatus.delete(pairingPc.id);
  showHome();
}
$('#pair-save').onclick = savePairing;
$('#pair-cancel').onclick = () => showHome();
for (const id of ['#pair-mac', '#pair-host', '#pair-port', '#pair-token']) {
  $(id).addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') savePairing();
    if (e.key === 'Escape') showHome();
  });
}

// ── WireWOL 설정 (WireGuard / 원격 WOL / 설정 파일) ──
function settingsMessage(text, info = false) {
  $('#set-msg').textContent = text;
  $('#set-msg').classList.toggle('info', info);
}
async function renderSettings() {
  const s = await window.rd.ww.get();
  const t = s.tunnel;
  $('#set-wg-status').textContent = !t.hasConf
    ? '등록된 설정이 없습니다. 공유기 등이 만들어준 WireGuard 설정(.conf)을 불러오세요. 집 밖에서 접속할 때만 필요합니다.'
    : {
        up: '설정됨 · 연결됨 — 이 프로그램을 끝낼 때 함께 꺼집니다.',
        direct: '설정됨 · PC에 바로 닿아서 켜지 않았습니다(집 네트워크이거나 다른 VPN이 연결됨).',
        notinstalled: '설정됨 · 내장 WireGuard 설치가 필요합니다(PC 선택 화면의 [설치]).',
        starting: '설정됨 · 연결 중...',
        error: `설정됨 · 오류: ${t.message}`,
      }[t.state] || '설정됨';
  $('#set-wg-clear').disabled = !t.hasConf;
  $('#set-r-state').textContent = s.router ? '(설정됨 — 비밀번호를 비워 두면 기존 비밀번호를 유지합니다)' : '';
  if (document.activeElement?.closest?.('#settings-view .grid2') == null) {
    $('#set-r-host').value = s.router?.host || '';
    $('#set-r-port').value = s.router?.port || '';
    $('#set-r-id').value = s.router?.id || '';
    $('#set-r-pw').value = '';
  }
  $('#set-r-clear').disabled = !s.router;
}
async function showSettings() {
  stopRetry();
  showView('#settings-view');
  $('#set-export-step').hidden = true;
  settingsMessage('');
  await renderSettings();
  $('#set-close').focus();
}
$('#home-settings').onclick = showSettings;
$('#set-close').onclick = () => showHome();
$('#set-wg-import').onclick = async () => {
  const r = await window.rd.ww.importConf();
  if (r.message) return settingsMessage(r.message);
  if (r.ok) settingsMessage('WireGuard 설정을 저장했습니다', true), renderSettings();
};
$('#set-wg-clear').onclick = async () => {
  const { response } = await window.rd.message({
    type: 'warning',
    title: 'WireGuard 설정 삭제',
    message: 'WireGuard 설정을 삭제하시겠습니까?',
    detail: '켜져 있던 내장 WireGuard도 꺼집니다.',
    buttons: ['삭제', '취소'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  await window.rd.ww.clearConf();
  settingsMessage('WireGuard 설정을 삭제했습니다', true);
  renderSettings();
};
$('#set-r-save').onclick = async () => {
  const r = await window.rd.ww.setRouter({
    host: $('#set-r-host').value,
    port: $('#set-r-port').value || '443',
    id: $('#set-r-id').value,
    password: $('#set-r-pw').value,
  });
  settingsMessage(r.ok ? '원격 WOL 설정을 저장했습니다' : r.message, r.ok);
  if (r.ok) renderSettings();
};
$('#set-r-clear').onclick = async () => {
  await window.rd.ww.clearRouter();
  settingsMessage('원격 WOL 설정을 삭제했습니다', true);
  $('#set-r-host').value = $('#set-r-port').value = $('#set-r-id').value = $('#set-r-pw').value = '';
  renderSettings();
};
$('#set-import').onclick = () => {
  showAdd();
  pickWireWol();
};
$('#set-export').onclick = async () => {
  const sel = $('#set-export-pc');
  sel.replaceChildren(...pcs.map((pc) => Object.assign(el('option', '', `${pc.name} (${addrOf(pc.server)})`), { value: pc.id })));
  sel.append(Object.assign(el('option', '', 'PC 정보 없이 (WireGuard·공유기 설정만)'), { value: '' }));
  const cur = await window.rd.pcs.current();
  if (cur) sel.value = cur;
  $('#set-export-step').hidden = false;
  $('#set-export-pw').value = $('#set-export-pw2').value = '';
  $('#set-export-pw').focus();
};
async function doExport() {
  if ($('#set-export-pw').value !== $('#set-export-pw2').value) return settingsMessage('비밀번호가 서로 다릅니다');
  settingsMessage('암호화하는 중...', true);
  const r = await window.rd.wirewol.export($('#set-export-pc').value, $('#set-export-pw').value);
  if (!r.ok) return settingsMessage(r.message || '');
  $('#set-export-step').hidden = true;
  settingsMessage(
    `${r.file}에 저장했습니다${r.withPairing ? '' : ' (이 PC에는 WireWOL 컴패니언 정보가 없어 PC 정보는 빠졌습니다)'} — 불러올 때 같은 비밀번호가 필요합니다`,
    true,
  );
}
$('#set-export-go').onclick = doExport;
for (const id of ['#set-r-host', '#set-r-port', '#set-r-id', '#set-r-pw', '#set-export-pw', '#set-export-pw2']) {
  $(id).addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') (id.startsWith('#set-r') ? $('#set-r-save') : $('#set-export-go')).click();
    if (e.key === 'Escape') showHome();
  });
}

// ── PC 추가 ──
function showAdd() {
  stopRetry();
  showView('#add-view');
  $('#connect-cancel').hidden = !pcs.length && !homeCancelable;
  $('#connect-input').value = '';
  setWireWolFile(null);
  connectMessage('');
  $('#connect-input').focus();
}
function closeAdd() {
  if (pcs.length) showHome();
  else if (homeCancelable) hideConnect();
}

function setWireWolFile(file, name) {
  wwFile = file;
  $('#wirewol-step').hidden = !file;
  $('#wirewol-file').textContent = file ? `(${name})` : '';
  $('#wirewol-password').value = '';
  $('#connect-go').textContent = file ? '불러와서 추가' : '추가하고 연결';
  if (file) $('#wirewol-password').focus();
}
async function pickWireWol(file) {
  file ??= await window.rd.wirewol.pick();
  if (!file) return;
  const r = await window.rd.wirewol.check(file);
  if (!r.ok) return connectMessage(r.message);
  connectMessage('');
  setWireWolFile(file, r.name);
}

async function doAdd() {
  const btn = $('#connect-go');
  const imported = !!wwFile;
  btn.disabled = true;
  if (wwFile) {
    btn.textContent = '불러오는 중...';
    const w = await window.rd.wirewol.import(wwFile, $('#wirewol-password').value);
    if (!w.ok) {
      btn.disabled = false;
      btn.textContent = '불러와서 추가';
      connectMessage(w.message);
      if (w.wrongPassword) $('#wirewol-password').select();
      return;
    }
    setWireWolFile(null);
    // PC 정보 없이 WireGuard·공유기 설정만 든 파일
    if (!w.host) {
      btn.disabled = false;
      await showSettings();
      return settingsMessage('설정 파일을 불러왔습니다 (파일에 PC 정보는 없었습니다)', true);
    }
    $('#connect-input').value = w.host;
  }
  if (!$('#connect-input').value.trim()) {
    btn.disabled = false;
    return connectMessage('PC 주소를 입력하세요');
  }
  btn.textContent = '연결 중...';
  const r = await window.rd.connection.connect($('#connect-input').value);
  btn.disabled = false;
  btn.textContent = '추가하고 연결';
  if (r.ok) {
    hideConnect();
    return start(r.info, r.server);
  }
  // WireWOL로 불러온 PC는 이미 목록에 있으므로 목록에서 연결(필요하면 와이어가드·PC 켜기)한다
  if (imported) {
    await showHome();
    const pc = pcs.find((p) => addrOf(p.server).startsWith(`${$('#connect-input').value.trim()}:`));
    if (pc) return connectPc(pc);
    return homeMessage(r.message);
  }
  connectMessage(r.message);
}

$('#connect-go').onclick = () => doAdd();
$('#connect-cancel').onclick = closeAdd;
$('#home-close').onclick = hideConnect;
$('#connect-wirewol').onclick = () => pickWireWol();
$('#status-conn').onclick = () => showHome(true);
for (const input of [$('#connect-input'), $('#wirewol-password')]) {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doAdd();
    if (e.key === 'Escape') {
      if (wwFile) setWireWolFile(null), $('#connect-input').focus();
      else if (!$('#connect-cancel').hidden) closeAdd();
    }
  });
}
$('#connect').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || renamingPc) return;
  if (!$('#settings-view').hidden || !$('#pair-view').hidden) return showHome();
  if (!$('#home-view').hidden && homeCancelable) hideConnect();
});
// wirewol_settings.json을 시작 화면에 끌어다 놓아도 불러온다
$('#connect').addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $('#connect').classList.add('drag');
});
$('#connect').addEventListener('dragleave', (e) => {
  if (!$('#connect').contains(e.relatedTarget)) $('#connect').classList.remove('drag');
});
$('#connect').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#connect').classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if ($('#add-view').hidden) showAdd();
  pickWireWol(window.rd.pathForFile(f));
});

// ───────────────────────── PC 끄기 / 예약 ─────────────────────────
let shutdownAt = 0;
let shutdownTimer = null;

function renderShutdown() {
  clearTimeout(shutdownTimer);
  const s = $('#status-shutdown');
  if (shutdownAt <= Date.now()) {
    shutdownAt = 0;
    s.hidden = true;
    return;
  }
  s.hidden = false;
  s.textContent = `${timeLabel(shutdownAt)} 종료 예약됨`;
  shutdownTimer = setTimeout(renderShutdown, Math.min(shutdownAt - Date.now() + 500, 60000));
}
async function currentPc() {
  const id = await window.rd.pcs.current();
  return (await window.rd.pcs.list()).find((p) => p.id === id);
}

/** 즉시 끄기(10초 유예, 그 사이 취소 가능). 성공하면 true */
async function powerOff(pc) {
  const { response } = await window.rd.message({
    type: 'warning',
    title: 'PC 끄기',
    message: `${pc.name}을(를) 종료하시겠습니까?`,
    detail: '10초 뒤 실제로 꺼지며, 그 사이 취소할 수 있습니다. 저장하지 않은 작업은 사라집니다.',
    buttons: ['종료', '취소'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return false;
  const r = await window.rd.pcs.shutdown(pc.id, null);
  if (!r.ok) {
    await showError(r.message, 'PC 끄기');
    return false;
  }
  if (state.server === pc.server) {
    shutdownAt = r.shutdownAt;
    renderShutdown();
  }
  let cancelled = false;
  toast('10초 후 PC가 종료됩니다', 'ok', {
    ms: 10000,
    action: '취소',
    onAction: async () => {
      cancelled = true;
      const c = await window.rd.pcs.cancelShutdown(pc.id);
      toast(c.ok ? '종료를 취소했습니다' : c.message, c.ok ? 'ok' : 'error');
      if (c.ok && state.server === pc.server) (shutdownAt = 0), renderShutdown();
    },
  });
  // 지금 보고 있는 PC를 껐으면 유예 시간이 지난 뒤 PC 선택 화면으로 돌아간다
  if (state.server === pc.server && overlayOpen() === false) {
    setTimeout(() => {
      if (cancelled) return;
      showHome(false);
      homeMessage(`${pc.name}을(를) 종료했습니다`, true);
    }, 11000);
  }
  return true;
}

function openSchedule() {
  $('#modal').hidden = false;
  $('#sched-msg').textContent = '';
  $('#sched-h').focus();
  $('#sched-h').select();
}
const closeSchedule = () => {
  $('#modal').hidden = true;
  $('#view').focus();
};
async function doSchedule() {
  const h = Number($('#sched-h').value) || 0;
  const m = Number($('#sched-m').value) || 0;
  if (h < 0 || h > 23 || m < 0 || m > 59 || !Number.isInteger(h) || !Number.isInteger(m)) return ($('#sched-msg').textContent = '0~23시간, 0~59분으로 입력하세요');
  const secs = h * 3600 + m * 60;
  if (secs <= 0) return ($('#sched-msg').textContent = '1분 이상으로 설정하세요');
  const pc = await currentPc();
  if (!pc) return closeSchedule();
  const r = await window.rd.pcs.shutdown(pc.id, secs);
  if (!r.ok) return ($('#sched-msg').textContent = r.message);
  closeSchedule();
  shutdownAt = r.shutdownAt;
  renderShutdown();
  toast(`${timeLabel(shutdownAt)}에 PC가 종료됩니다`);
}
async function cancelSchedule() {
  const pc = await currentPc();
  if (!pc) return;
  const r = await window.rd.pcs.cancelShutdown(pc.id);
  toast(r.ok ? '종료 예약을 취소했습니다' : r.message, r.ok ? 'ok' : 'error');
  if (r.ok) (shutdownAt = 0), renderShutdown();
}
$('#btn-power').onclick = async () => {
  const pc = await currentPc();
  if (pc) powerOff(pc);
};
$('#btn-power-more').onclick = async () => {
  const id = await window.rd.menu([
    { id: 'off', label: '지금 끄기 (10초 뒤)' },
    { id: 'schedule', label: '예약 끄기...' },
    { id: 'cancel', label: `종료 예약 취소${shutdownAt ? ` (${timeLabel(shutdownAt)})` : ''}`, enabled: !!shutdownAt },
  ]);
  if (id === 'off') $('#btn-power').click();
  else if (id === 'schedule') openSchedule();
  else if (id === 'cancel') cancelSchedule();
};
$('#status-shutdown').onclick = cancelSchedule;
$('#sched-go').onclick = doSchedule;
$('#sched-cancel').onclick = closeSchedule;
for (const id of ['#sched-h', '#sched-m']) {
  $(id).addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doSchedule();
    if (e.key === 'Escape') closeSchedule();
  });
}
// 다른 곳(WireWOL 앱, 다른 창)에서 건 예약도 반영
setInterval(async () => {
  if (overlayOpen() || !state.info || document.visibilityState !== 'visible') return;
  const r = await window.rd.connection.info();
  if (r.ok && (r.data.shutdownAt || 0) !== shutdownAt) (shutdownAt = r.data.shutdownAt || 0), renderShutdown();
}, 30000);

async function start(info, server) {
  state.info = info;
  state.server = server;
  state.connected = true;
  shutdownAt = info.shutdownAt || 0;
  renderShutdown();
  $('#status-conn').classList.remove('off');
  $('#status-host').textContent = info.hostname;
  $('#status-conn').title = `${info.user}@${info.hostname} — 클릭하면 다른 PC 선택`;
  const [r] = await Promise.all([call('GET', '/api/fs/drives'), loadQuickAccess()]);
  if (r.ok) state.drives = r.data;
  renderSidebar();
  const startPath = new URLSearchParams(location.search).get('path');
  state.history = [];
  state.hIdx = -1;
  navigate(startPath ? { kind: 'dir', path: startPath } : { kind: 'pc' });
  $('#view').focus();
}

(async () => {
  const { server, explorer } = await window.rd.connection.get();
  if (explorer) winPrefs = explorer;
  // 앱을 처음 켤 때는 항상 PC 선택 화면부터 (새 창은 지금 PC로 바로 연다)
  if (new URLSearchParams(location.search).has('home') || !server) return showHome(false);
  const r = await window.rd.connection.info();
  if (r.ok) return start(r.data, server);
  showHome(false);
})();
