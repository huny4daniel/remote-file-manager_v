import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { execFile } from 'node:child_process';
import { getDrives, moveToRecycleBin, resolveShortcut } from './winshell.js';

export interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
  ctime: number;
  /** 숨김 속성 */
  hidden: boolean;
  /** 보호된 운영체제 파일 (숨김+시스템 속성) */
  system: boolean;
}

// 속성을 읽지 못해도 보호된 운영체제 파일로 취급할 항목 / 레거시 정션
const SYSTEM_NAMES = new Set([
  'desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information', 'pagefile.sys', 'hiberfil.sys',
  'swapfile.sys', 'dumpstack.log.tmp', 'dumpstack.log', 'config.msi', 'documents and settings', 'application data',
  'cookies', 'local settings', 'my documents', 'nethood', 'printhood', 'recent', 'sendto', 'start menu', 'templates',
  'ntuser.dat', 'ntuser.ini', 'ntuser.pol',
]);
const isSystemName = (name: string) => {
  const lower = name.toLowerCase();
  return SYSTEM_NAMES.has(lower) || lower.startsWith('ntuser.dat');
};

interface Attribs {
  hidden: Set<string>;
  system: Set<string>;
}

/** Windows 숨김/시스템 속성이 있는 항목 이름. 폴더 수정 시각이 같으면 캐시를 쓴다 */
const attribCache = new Map<string, { mtime: number; attrs: Attribs }>();
function readAttribs(dir: string): Promise<Attribs> {
  if (process.platform !== 'win32') return Promise.resolve({ hidden: new Set(), system: new Set() });
  const q = dir.replace(/"/g, '');
  return new Promise((resolve) => {
    execFile(
      'cmd.exe',
      ['/d', '/s', '/c', `"chcp 65001>nul & dir /a:h /b "${q}" 2>nul & echo ::: & dir /a:hs /b "${q}" 2>nul"`],
      { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
      (_err, stdout) => {
        const [h = '', s = ''] = String(stdout || '').split(':::');
        const set = (t: string) => new Set(t.split(/\r?\n/).map((n) => n.trim().toLowerCase()).filter(Boolean));
        resolve({ hidden: set(h), system: set(s) });
      },
    );
  });
}
async function attribsOf(dir: string): Promise<Attribs> {
  let mtime = 0;
  try {
    mtime = (await fsp.stat(dir)).mtimeMs;
  } catch {
    /* 무시 */
  }
  const c = attribCache.get(dir.toLowerCase());
  if (c && c.mtime === mtime) return c.attrs;
  const attrs = await readAttribs(dir);
  attribCache.set(dir.toLowerCase(), { mtime, attrs });
  if (attribCache.size > 500) attribCache.delete(attribCache.keys().next().value!);
  return attrs;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: object) {
    super(message);
  }
}

function requirePath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) throw new HttpError(400, 'EINVAL', '경로가 필요합니다');
  if (!path.isAbsolute(p)) throw new HttpError(400, 'EINVAL', '절대 경로여야 합니다');
  return path.resolve(p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function toEntry(dir: string, name: string): Promise<Entry | null> {
  const full = path.join(dir, name);
  try {
    const st = await fsp.stat(full);
    return {
      name,
      path: full,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
      ctime: st.birthtimeMs,
      hidden: isSystemName(name),
      system: isSystemName(name),
    };
  } catch {
    // 접근 불가(정션, 잠긴 시스템 파일 등) — 숨김 항목으로 취급
    return { name, path: full, type: 'link', size: 0, mtime: 0, ctime: 0, hidden: true, system: true };
  }
}

/** "이름 - 복사본", "이름 - 복사본 (2)" 형태의 겹치지 않는 경로 */
async function uniqueCopyName(destDir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const realExt = ext && ext !== name ? ext : '';
  for (let i = 1; ; i++) {
    const candidate = path.join(destDir, `${base} - 복사본${i > 1 ? ` (${i})` : ''}${realExt}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/** "새 폴더", "새 폴더 (2)" 형태 */
async function uniqueNewName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function movePath(src: string, dest: string) {
  try {
    await fsp.rename(src, dest);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, dest, { recursive: true, force: true, preserveTimestamps: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function fsRouter(): Router {
  const r = Router();

  r.get('/drives', wrap(async (_req, res) => {
    res.json(await getDrives());
  }));

  r.get('/list', wrap(async (req, res) => {
    const dir = requirePath(req.query.path);
    const [names, attrs] = await Promise.all([fsp.readdir(dir), attribsOf(dir)]);
    const entries = (await Promise.all(names.map((n) => toEntry(dir, n)))).filter((e): e is Entry => !!e);
    for (const e of entries) {
      const n = e.name.toLowerCase();
      if (attrs.hidden.has(n)) e.hidden = true;
      if (attrs.system.has(n)) e.system = true;
    }
    res.json({ path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries });
  }));

  r.get('/stat', wrap(async (req, res) => {
    const p = requirePath(req.query.path);
    const entry = await toEntry(path.dirname(p), path.basename(p));
    if (!entry || entry.type === 'link') throw new HttpError(404, 'ENOENT', '찾을 수 없습니다');
    res.json(entry);
  }));

  /** 바로 가기(.lnk) 대상 */
  r.get('/shortcut', wrap(async (req, res) => {
    const p = requirePath(req.query.path);
    const target = (await resolveShortcut(p)).trim();
    if (!target) throw new HttpError(404, 'ENOENT', '바로 가기 대상을 찾을 수 없습니다');
    const entry = await toEntry(path.dirname(target), path.basename(target));
    if (!entry || entry.type === 'link') throw new HttpError(404, 'ENOENT', `바로 가기 대상 '${target}'을(를) 찾을 수 없습니다`);
    res.json(entry);
  }));

  r.post('/mkdir',wrap(async (req, res) => {
    const dir = requirePath(req.body.dir);
    const target = await uniqueNewName(dir, req.body.name || '새 폴더');
    await fsp.mkdir(target);
    res.json({ path: target });
  }));

  r.post('/mkdirp', wrap(async (req, res) => {
    const p = requirePath(req.body.path);
    await fsp.mkdir(p, { recursive: true });
    res.json({ path: p });
  }));

  r.post('/newfile', wrap(async (req, res) => {
    const dir = requirePath(req.body.dir);
    const target = await uniqueNewName(dir, req.body.name || '새 텍스트 문서.txt');
    await fsp.writeFile(target, '', { flag: 'wx' });
    res.json({ path: target });
  }));

  r.post('/rename', wrap(async (req, res) => {
    const from = requirePath(req.body.path);
    const name = String(req.body.name ?? '').trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) {
      throw new HttpError(400, 'EINVAL', '파일 이름에는 다음 문자를 사용할 수 없습니다: \\ / : * ? " < > |');
    }
    const to = path.join(path.dirname(from), name);
    if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) {
      throw new HttpError(409, 'EEXIST', '이 위치에 같은 이름의 파일이나 폴더가 이미 있습니다');
    }
    await fsp.rename(from, to);
    res.json({ path: to });
  }));

  r.post('/delete', wrap(async (req, res) => {
    const paths: string[] = (req.body.paths ?? []).map(requirePath);
    if (req.body.permanent || process.platform !== 'win32') {
      for (const p of paths) await fsp.rm(p, { recursive: true, force: true });
    } else {
      await moveToRecycleBin(paths);
    }
    res.json({ ok: true });
  }));

  /**
   * 복사/이동. onConflict: 없음이면 충돌 시 409, 'overwrite' | 'skip' | 'rename'
   */
  r.post('/transfer', wrap(async (req, res) => {
    const sources: string[] = (req.body.sources ?? []).map(requirePath);
    const destDir = requirePath(req.body.destDir);
    const move = !!req.body.move;
    const onConflict: string | undefined = req.body.onConflict;

    const plan = await Promise.all(
      sources.map(async (src) => {
        const dest = path.join(destDir, path.basename(src));
        const same = dest.toLowerCase() === src.toLowerCase();
        return { src, dest, same, conflict: same || (await exists(dest)) };
      }),
    );
    for (const p of plan) {
      if (!p.same && (destDir + path.sep).toLowerCase().startsWith((p.src + path.sep).toLowerCase())) {
        throw new HttpError(400, 'EINVAL', '대상 폴더가 원본 폴더의 하위 폴더입니다');
      }
    }
    const conflicts = plan.filter((p) => p.conflict && !(p.same && !move));
    if (conflicts.length && !onConflict) {
      throw new HttpError(409, 'ECONFLICT', '대상 위치에 같은 이름의 항목이 있습니다', {
        conflicts: conflicts.map((c) => path.basename(c.dest)),
      });
    }

    const results: string[] = [];
    for (const p of plan) {
      let dest = p.dest;
      if (p.same) {
        if (move) continue; // 같은 폴더로 이동은 무시
        dest = await uniqueCopyName(destDir, path.basename(p.src));
      } else if (p.conflict) {
        if (onConflict === 'skip') continue;
        if (onConflict === 'rename') dest = await uniqueCopyName(destDir, path.basename(p.src));
        if (onConflict === 'overwrite') await fsp.rm(dest, { recursive: true, force: true });
      }
      if (move) await movePath(p.src, dest);
      else await fsp.cp(p.src, dest, { recursive: true, force: true, preserveTimestamps: true });
      results.push(dest);
    }
    res.json({ paths: results });
  }));

  r.get('/download', wrap(async (req, res) => {
    const p = requirePath(req.query.path);
    const st = await fsp.stat(p);
    if (st.isDirectory()) throw new HttpError(400, 'EISDIR', '폴더는 내려받을 수 없습니다');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Mtime', String(st.mtimeMs));
    await pipeline(fs.createReadStream(p), res);
  }));

  r.put('/upload', wrap(async (req, res) => {
    const p = requirePath(req.query.path);
    if (req.query.overwrite !== '1' && (await exists(p))) {
      throw new HttpError(409, 'EEXIST', '같은 이름의 파일이 이미 있습니다');
    }
    const tmp = `${p}.rdpart`;
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      await fsp.rename(tmp, p);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const st = await fsp.stat(p);
    res.json({ path: p, size: st.size, mtime: st.mtimeMs });
  }));

  /** 하위 폴더까지 이름으로 검색 (탐색기 검색창) */
  r.get('/search', wrap(async (req, res) => {
    const root = requirePath(req.query.path);
    const q = String(req.query.q ?? '').toLowerCase();
    if (!q) return res.json({ entries: [], truncated: false });
    const limit = 500;
    const deadline = Date.now() + 8000;
    const out: Entry[] = [];
    const queue = [root];
    let truncated = false;
    while (queue.length) {
      if (out.length >= limit || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const dir = queue.shift()!;
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (isSystemName(d.name)) continue;
        if (d.isDirectory()) queue.push(path.join(dir, d.name));
        if (d.name.toLowerCase().includes(q)) {
          const e = await toEntry(dir, d.name);
          if (e && e.type !== 'link') out.push(e);
        }
      }
    }
    res.json({ entries: out, truncated });
  }));

  r.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ code: err.code, message: err.message, ...err.extra });
    }
    const map: Record<string, [number, string]> = {
      ENOENT: [404, '파일이나 폴더를 찾을 수 없습니다'],
      EACCES: [403, '액세스가 거부되었습니다'],
      EPERM: [403, '액세스가 거부되었습니다'],
      EBUSY: [423, '다른 프로그램에서 사용 중이라 작업을 완료할 수 없습니다'],
      EEXIST: [409, '같은 이름의 항목이 이미 있습니다'],
      ENOTEMPTY: [409, '폴더가 비어 있지 않습니다'],
    };
    const [status, message] = map[err.code] ?? [500, err.message ?? String(err)];
    res.status(status).json({ code: err.code ?? 'EUNKNOWN', message });
  });

  return r;
}
