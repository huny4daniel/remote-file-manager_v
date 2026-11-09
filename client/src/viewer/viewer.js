/* 원격 PC 파일을 내려받은 사본으로 보여주는 창 (이미지 / 동영상 / 소리 / PDF / 텍스트) */
'use strict';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const kind = params.get('kind');
const remotePath = params.get('remote');
let localPath = params.get('local');
let size = Number(params.get('size') || 0);

const name = remotePath.split(/[\\/]/).filter(Boolean).pop() || remotePath;
const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
const stage = $('#stage');

document.title = name;
$('#tab-title').textContent = name;
$('#status-path').textContent = remotePath;
window.rd.icon(ext, 'small').then((u) => u && ($('#tab-icon').src = u));

const pref = {
  get(k, def) {
    try {
      const v = localStorage.getItem(`viewer.${k}`);
      return v === null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`viewer.${k}`, JSON.stringify(v));
    } catch {
      /* 저장 못 해도 동작에는 지장 없음 */
    }
  },
};

function fileUrl(p, bust) {
  const url = 'file:///' + p.split('\\').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
  return bust ? `${url}?t=${Date.now()}` : url;
}

function formatSize(n) {
  if (n < 1024) return `${n} 바이트`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const setInfo = (parts) => ($('#status-info').textContent = parts.filter(Boolean).join('   '));

function showNotice(glyph, message, { action = true } = {}) {
  stage.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'notice';
  const box = document.createElement('div');
  box.className = 'box';
  const g = document.createElement('i');
  g.className = 'glyph';
  g.textContent = glyph;
  const msg = document.createElement('div');
  msg.textContent = message;
  box.append(g, msg);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = '노트북 기본 앱으로 열기';
    btn.onclick = openExternal;
    box.append(btn);
  }
  wrap.append(box);
  stage.append(wrap);
}

// ───────────────────────── 이미지 ─────────────────────────
const img = { el: null, wrap: null, scale: 'fit', natural: [0, 0] };

function currentScale() {
  if (img.scale !== 'fit') return img.scale;
  const [w, h] = img.natural;
  if (!w || !h) return 1;
  return Math.min(1, img.wrap.clientWidth / w, img.wrap.clientHeight / h);
}

function applyZoom(anchor) {
  const fit = img.scale === 'fit';
  const s = currentScale();
  const [w, h] = img.natural;
  const before = anchor && {
    x: (img.wrap.scrollLeft + anchor.x) / img.el.offsetWidth,
    y: (img.wrap.scrollTop + anchor.y) / img.el.offsetHeight,
  };
  img.wrap.classList.toggle('fit', fit);
  img.el.style.width = fit ? '' : `${Math.round(w * s)}px`;
  img.el.style.height = fit ? '' : `${Math.round(h * s)}px`;
  img.wrap.classList.toggle('pixel', s > 2);
  const overflow = !fit && (w * s > img.wrap.clientWidth || h * s > img.wrap.clientHeight);
  img.wrap.classList.toggle('grab', overflow);
  if (before) {
    img.wrap.scrollLeft = before.x * img.el.offsetWidth - anchor.x;
    img.wrap.scrollTop = before.y * img.el.offsetHeight - anchor.y;
  }
  $('#zoom-label').textContent = `${Math.round(s * 100)}%`;
  $('#fit-label').textContent = fit ? '실제 크기' : '창에 맞추기';
}

const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
function zoomImage(dir, anchor) {
  const s = currentScale();
  const next = dir > 0 ? ZOOM_STEPS.find((v) => v > s + 1e-6) : [...ZOOM_STEPS].reverse().find((v) => v < s - 1e-6);
  if (!next) return;
  img.scale = next;
  applyZoom(anchor);
}

function renderImage(bust) {
  $('#tools-image').hidden = false;
  const wrap = document.createElement('div');
  wrap.className = 'image-wrap fit';
  const el = new Image();
  el.draggable = false;
  el.onload = () => {
    img.natural = [el.naturalWidth || 300, el.naturalHeight || 150];
    applyZoom();
    setInfo([el.naturalWidth ? `${el.naturalWidth} × ${el.naturalHeight} 픽셀` : '', formatSize(size)]);
  };
  el.onerror = () => showNotice('', '이 이미지를 표시할 수 없습니다.');
  el.src = fileUrl(localPath, bust);
  wrap.append(el);
  stage.replaceChildren(wrap);
  Object.assign(img, { el, wrap });

  wrap.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      zoomImage(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
    },
    { passive: false },
  );
  // 화면보다 크면 끌어서 이동
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !wrap.classList.contains('grab')) return;
    const start = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('grabbing');
    const move = (ev) => {
      wrap.scrollLeft = start.l - (ev.clientX - start.x);
      wrap.scrollTop = start.t - (ev.clientY - start.y);
    };
    const up = () => {
      wrap.classList.remove('grabbing');
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', up);
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
  });
  wrap.addEventListener('dblclick', toggleFit);
}

function toggleFit() {
  img.scale = img.scale === 'fit' ? 1 : 'fit';
  applyZoom();
}

$('#btn-zoom-in').onclick = () => zoomImage(1);
$('#btn-zoom-out').onclick = () => zoomImage(-1);
$('#btn-fit').onclick = toggleFit;
new ResizeObserver(() => img.el && img.scale === 'fit' && applyZoom()).observe(stage);

// ───────────────────────── 동영상 / 소리 / PDF ─────────────────────────
function mediaError() {
  showNotice('', '이 형식은 여기서 재생할 수 없습니다. 노트북 기본 앱으로 열어 보세요.');
}

function renderVideo(bust) {
  const wrap = document.createElement('div');
  wrap.className = 'media-wrap';
  const v = document.createElement('video');
  v.controls = true;
  v.autoplay = true;
  v.onloadedmetadata = () => setInfo([v.videoWidth ? `${v.videoWidth} × ${v.videoHeight}` : '', formatDuration(v.duration), formatSize(size)]);
  v.onerror = mediaError;
  v.src = fileUrl(localPath, bust);
  wrap.append(v);
  stage.replaceChildren(wrap);
  v.focus();
}

async function renderAudio(bust) {
  const wrap = document.createElement('div');
  wrap.className = 'audio-wrap';
  const card = document.createElement('div');
  card.className = 'card';
  const icon = new Image();
  window.rd.icon(ext, 'large').then((u) => u && (icon.src = u));
  const label = document.createElement('div');
  label.className = 'name';
  label.textContent = name;
  const a = document.createElement('audio');
  a.controls = true;
  a.autoplay = true;
  a.onloadedmetadata = () => setInfo([formatDuration(a.duration), formatSize(size)]);
  a.onerror = mediaError;
  a.src = fileUrl(localPath, bust);
  card.append(icon, label, a);
  wrap.append(card);
  stage.replaceChildren(wrap);
  a.focus();
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function renderPdf(bust) {
  const f = document.createElement('iframe');
  f.className = 'pdf';
  f.src = fileUrl(localPath, bust);
  stage.replaceChildren(f);
  setInfo([formatSize(size)]);
}

// ───────────────────────── 텍스트 ─────────────────────────
const text = { wrapEl: null, codeEl: null, font: pref.get('fontSize', 13), wrap: pref.get('wrap', false) };

function applyTextPrefs() {
  if (!text.wrapEl) return;
  text.wrapEl.classList.toggle('wrap', text.wrap);
  text.wrapEl.style.fontSize = `${text.font}px`;
  $('#btn-wrap').classList.toggle('on', text.wrap);
}

async function renderText() {
  $('#tools-text').hidden = false;
  let result;
  try {
    result = await window.rd.viewer.text(localPath);
  } catch (e) {
    return showNotice('', `파일을 읽을 수 없습니다: ${e.message}`);
  }
  const content = result.text.replace(/\r\n?/g, '\n');
  const lines = content ? content.split('\n').length : 1;
  const wrap = document.createElement('div');
  wrap.className = 'text-wrap';
  const gutter = document.createElement('pre');
  gutter.className = 'gutter';
  let nums = '';
  for (let i = 1; i <= lines; i++) nums += i === lines ? `${i}` : `${i}\n`;
  gutter.textContent = nums;
  const code = document.createElement('pre');
  code.className = 'code';
  code.textContent = content;
  wrap.append(gutter, code);
  stage.replaceChildren(wrap);
  Object.assign(text, { wrapEl: wrap, codeEl: code });
  applyTextPrefs();
  setInfo([`${lines.toLocaleString()}줄`, result.encoding, formatSize(size)]);
}

$('#btn-wrap').onclick = () => {
  text.wrap = !text.wrap;
  pref.set('wrap', text.wrap);
  applyTextPrefs();
};
function textFont(d) {
  text.font = d === 0 ? 13 : Math.max(8, Math.min(32, text.font + d));
  pref.set('fontSize', text.font);
  applyTextPrefs();
}
$('#btn-font-in').onclick = () => textFont(1);
$('#btn-font-out').onclick = () => textFont(-1);

// ───────────────────────── 웹 페이지 (미리 보기 / 소스) ─────────────────────────
// 미리 보기는 페이지가 요청하는 css·js·이미지를 그때그때 원격 PC에서 가져온다 (rfm-site://)
const site = { preview: true, frame: null };

async function renderHtml(bust) {
  $('#tools-html').hidden = false;
  $('#mode-label').textContent = site.preview ? '소스 보기' : '미리 보기';
  $('#mode-glyph').textContent = site.preview ? '' : '';
  $('#tools-text').hidden = site.preview;
  if (!site.preview) {
    site.frame = null;
    return renderText();
  }
  text.wrapEl = null;
  const url = await window.rd.viewer.siteUrl(remotePath);
  if (!url) return showNotice('', '이 위치의 페이지는 미리 볼 수 없습니다.');
  const f = document.createElement('iframe');
  f.className = 'site';
  f.allow = 'fullscreen; clipboard-read; clipboard-write; geolocation; autoplay';
  f.src = bust ? `${url}?t=${Date.now()}` : url;
  stage.replaceChildren(f);
  site.frame = f;
  setInfo(['미리 보기', formatSize(size)]);
  f.focus();
}

$('#btn-mode').onclick = () => {
  site.preview = !site.preview;
  render();
};
$('#btn-devtools').onclick = () => window.rd.viewer.devtools();

// ───────────────────────── 공통 동작 ─────────────────────────
const renderers = { image: renderImage, video: renderVideo, audio: renderAudio, pdf: renderPdf, text: renderText, html: renderHtml };

function render(bust = false) {
  const fn = renderers[kind];
  if (!fn) return showNotice('', '이 형식은 미리 볼 수 없습니다.');
  return fn(bust);
}

/** 재생 중인 파일을 놓아야 다시 내려받으며 덮어쓸 수 있다 */
function releaseMedia() {
  for (const m of stage.querySelectorAll('video, audio')) {
    m.pause();
    m.removeAttribute('src');
    m.load();
  }
  stage.replaceChildren();
}

async function reload() {
  if (kind === 'html' && site.preview) return renderHtml(true);
  const keepScroll = text.wrapEl ? [text.wrapEl.scrollLeft, text.wrapEl.scrollTop] : null;
  releaseMedia();
  const r = await window.rd.viewer.reload(remotePath);
  if (!r) return showNotice('', '파일을 다시 불러오지 못했습니다.', { action: false });
  localPath = r.localPath;
  size = r.size;
  await render(true);
  if (keepScroll && text.wrapEl) [text.wrapEl.scrollLeft, text.wrapEl.scrollTop] = keepScroll;
}

function openExternal() {
  return window.rd.viewer.external(localPath, remotePath);
}

$('#btn-external').onclick = openExternal;
$('#btn-save').onclick = () => window.rd.downloadEntries([{ path: remotePath, name, type: 'file', size }]);
$('#btn-reload').onclick = reload;

document.addEventListener('keydown', (e) => {
  const code = e.code;
  if (e.altKey && code === 'KeyZ' && text.wrapEl) {
    e.preventDefault();
    return $('#btn-wrap').click();
  }
  if (e.ctrlKey && (code === 'Equal' || code === 'NumpadAdd' || code === 'Minus' || code === 'NumpadSubtract' || code === 'Digit0' || code === 'Numpad0')) {
    const d = code === 'Equal' || code === 'NumpadAdd' ? 1 : code === 'Digit0' || code === 'Numpad0' ? 0 : -1;
    e.preventDefault();
    if (kind === 'image') return d === 0 ? ((img.scale = 'fit'), applyZoom()) : zoomImage(d);
    if (text.wrapEl) return textFont(d);
  }
});
window.rd.onViewerKey((cmd) => cmd === 'reload' && reload());

render();
