import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** PowerShell 스크립트를 실행하고 stdout을 반환. 인자는 환경 변수(RD_ARGS, JSON)로 넘겨 주입을 막는다 */
export function runPowerShell(script: string, args: unknown = null, timeoutMs = 30000): Promise<string> {
  const prelude = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $rdArgs = $env:RD_ARGS | ConvertFrom-Json; ';
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + script],
      { env: { ...process.env, RD_ARGS: JSON.stringify(args) }, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

export interface KnownFolder {
  id: string;
  name: string;
  path: string;
}

export async function getKnownFolders(): Promise<KnownFolder[]> {
  const home = os.homedir();
  const fallback: KnownFolder[] = [
    { id: 'desktop', name: '바탕 화면', path: path.join(home, 'Desktop') },
    { id: 'downloads', name: '다운로드', path: path.join(home, 'Downloads') },
    { id: 'documents', name: '문서', path: path.join(home, 'Documents') },
    { id: 'pictures', name: '사진', path: path.join(home, 'Pictures') },
    { id: 'music', name: '음악', path: path.join(home, 'Music') },
    { id: 'videos', name: '동영상', path: path.join(home, 'Videos') },
  ];
  if (process.platform !== 'win32') return fallback;
  try {
    const out = await runPowerShell(
      `$sh = New-Object -ComObject Shell.Application; ` +
        `@('Desktop','Downloads','Personal','My Pictures','My Music','My Video') | ForEach-Object { ` +
        `try { $sh.NameSpace("shell:$_").Self.Path } catch { '' } } | ConvertTo-Json`,
    );
    const paths: string[] = JSON.parse(out);
    return fallback.map((f, i) => ({ ...f, path: paths[i] || f.path }));
  } catch {
    return fallback;
  }
}

export interface DriveInfo {
  path: string;
  letter: string;
  label: string;
  type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'other';
  size: number | null;
  free: number | null;
}

export async function getDrives(): Promise<DriveInfo[]> {
  if (process.platform !== 'win32') return [{ path: '/', letter: '/', label: 'Root', type: 'fixed', size: null, free: null }];
  const out = await runPowerShell(
    `@(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, DriveType, Size, FreeSpace) | ConvertTo-Json -Compress`,
  );
  const raw = JSON.parse(out || '[]');
  const list: any[] = Array.isArray(raw) ? raw : [raw];
  const typeMap: Record<number, DriveInfo['type']> = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };
  return list.map((d) => ({
    path: `${d.DeviceID}\\`,
    letter: d.DeviceID,
    label: d.VolumeName || '',
    type: typeMap[d.DriveType] ?? 'other',
    size: d.Size ?? null,
    free: d.FreeSpace ?? null,
  }));
}

const CODEPAGE_LABELS: Record<number, string> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' };

/** 시스템 ANSI 코드 페이지 디코더 (구형 .lnk의 비유니코드 경로용). 한 번만 조회한다 */
let ansiPromise: Promise<TextDecoder | null> | null = null;
export function ansiDecoder(): Promise<TextDecoder | null> {
  ansiPromise ??= new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { windowsHide: true }, (err, stdout) => {
      const acp = Number(/ACP\s+REG_SZ\s+(\d+)/.exec(stdout)?.[1]);
      try {
        resolve(err || !acp ? null : new TextDecoder(CODEPAGE_LABELS[acp] ?? `windows-${acp}`));
      } catch {
        resolve(null);
      }
    });
  });
  return ansiPromise;
}

/** .lnk(MS-SHLLINK) 바이너리에서 대상 경로를 직접 읽는다. 해석할 수 없는 형식이면 null */
export function parseShortcut(buf: Buffer, ansi: TextDecoder | null = null): string | null {
  if (buf.length < 0x4c || buf.readUInt32LE(0) !== 0x4c) return null;
  const flags = buf.readUInt32LE(0x14);
  const unicode = (flags & 0x80) !== 0;
  let off = 0x4c;
  if (flags & 0x01) off += 2 + buf.readUInt16LE(off); // LinkTargetIDList
  const cstr = (at: number, wide: boolean): string | null => {
    if (wide) {
      let end = at;
      while (end + 1 < buf.length && buf.readUInt16LE(end) !== 0) end += 2;
      return buf.toString('utf16le', at, end);
    }
    const end = buf.indexOf(0, at);
    const bytes = buf.subarray(at, end < 0 ? buf.length : end);
    if (!bytes.some((b) => b > 0x7f)) return bytes.toString('latin1');
    return ansi ? ansi.decode(bytes) : null;
  };

  let target: string | null = null;
  if (flags & 0x02) {
    // LinkInfo
    const info = off;
    const infoSize = buf.readUInt32LE(info);
    const headerSize = buf.readUInt32LE(info + 4);
    const infoFlags = buf.readUInt32LE(info + 8);
    const suffix =
      headerSize >= 0x24 && buf.readUInt32LE(info + 32)
        ? cstr(info + buf.readUInt32LE(info + 32), true)
        : cstr(info + buf.readUInt32LE(info + 24), false);
    if (infoFlags & 0x01) {
      const base =
        headerSize >= 0x24 && buf.readUInt32LE(info + 28)
          ? cstr(info + buf.readUInt32LE(info + 28), true)
          : cstr(info + buf.readUInt32LE(info + 16), false);
      if (base != null && suffix != null) target = base + suffix;
    } else if (infoFlags & 0x02) {
      const net = info + buf.readUInt32LE(info + 20);
      const nameOff = buf.readUInt32LE(net + 8);
      const name = nameOff > 0x14 ? cstr(net + buf.readUInt32LE(net + 20), true) : cstr(net + nameOff, false);
      if (name != null && suffix != null) target = suffix ? `${name}\\${suffix}` : name;
    }
    off += infoSize;
  }
  if (target) return target;

  // StringData를 건너뛰고 ExtraData의 환경 변수 블록(%windir% 등)을 찾는다
  for (const bit of [0x04, 0x08, 0x10, 0x20, 0x40]) if (flags & bit) off += 2 + buf.readUInt16LE(off) * (unicode ? 2 : 1);
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32LE(off);
    if (size < 4) break;
    if (buf.readUInt32LE(off + 4) === 0xa0000001 && size >= 0x314) {
      const raw = cstr(off + 8 + 260, true);
      if (raw) return raw.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
    }
    off += size;
  }
  return null;
}

export async function resolveShortcut(lnk: string): Promise<string> {
  // PowerShell은 실행마다 수백 ms가 걸리므로 직접 파싱하고, 실패할 때만 COM으로 읽는다
  try {
    const target = parseShortcut(await fsp.readFile(lnk), await ansiDecoder());
    if (target) return target;
  } catch {
    /* 아래로 */
  }
  return (await runPowerShell(`(New-Object -ComObject WScript.Shell).CreateShortcut($rdArgs).TargetPath`, lnk)).trim();
}

export interface QuickAccessItem {
  name: string;
  path: string;
  pinned: boolean;
}

const QUICK_ACCESS = `$qa = (New-Object -ComObject Shell.Application).Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}'); `;

/** 탐색기 즐겨찾기(홈)의 폴더 목록. 고정 항목과 자주 사용하는 폴더가 섞여 있다 */
export async function getQuickAccess(): Promise<QuickAccessItem[]> {
  if (process.platform !== 'win32') return [];
  const out = await runPowerShell(
    QUICK_ACCESS +
      `@($qa.Items() | Where-Object { $_.IsFolder -and $_.Path -match '^([A-Za-z]:|\\\\\\\\)' } | ForEach-Object { ` +
      `[pscustomobject]@{ name = $_.Name; path = $_.Path; pinned = [bool]$_.ExtendedProperty('System.Home.IsPinned') } }) | ConvertTo-Json -Compress`,
  );
  const raw = JSON.parse(out.trim() || '[]');
  return Array.isArray(raw) ? raw : [raw];
}

export async function pinQuickAccess(dir: string): Promise<void> {
  await runPowerShell(
    `$f = (New-Object -ComObject Shell.Application).Namespace($rdArgs); ` +
      `if (-not $f) { throw '폴더를 찾을 수 없습니다' }; $f.Self.InvokeVerb('pintohome')`,
    dir,
  );
}

/** 고정 해제. 자주 사용하는 폴더로 자동 표시된 항목이면 목록에서 제거한다 */
export async function unpinQuickAccess(dir: string): Promise<void> {
  await runPowerShell(
    QUICK_ACCESS +
      `$it = $qa.Items() | Where-Object { $_.Path -eq $rdArgs } | Select-Object -First 1; ` +
      `if (-not $it) { throw '즐겨찾기에 없는 항목입니다' }; ` +
      `if ($it.ExtendedProperty('System.Home.IsPinned')) { $it.InvokeVerb('unpinfromhome') } else { $it.InvokeVerb('removefromhome') }`,
    dir,
  );
}

let sidPromise: Promise<string> | null = null;
function currentSid(): Promise<string> {
  sidPromise ??= runPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value').then((s) => s.trim());
  return sidPromise;
}

/** $I 파일(원래 경로·삭제 시각)을 읽는다. 버전 1은 경로가 고정 길이, 버전 2는 길이가 앞에 붙는다 */
function parseRecycleInfo(buf: Buffer): { path: string; time: bigint } | null {
  if (buf.length < 28) return null;
  const version = buf.readBigInt64LE(0);
  const time = buf.readBigInt64LE(16);
  let s: string;
  if (version === 2n) s = buf.toString('utf16le', 28, 28 + buf.readUInt32LE(24) * 2);
  else if (version === 1n) s = buf.toString('utf16le', 24, Math.min(buf.length, 24 + 520));
  else return null;
  return { path: s.replace(/\0[\s\S]*$/, ''), time };
}

/** 휴지통에서 원래 경로가 p인 항목 중 가장 최근에 버린 것 ($R: 실제 데이터, $I: 정보 파일) */
export async function findInRecycleBin(p: string): Promise<{ data: string; info: string } | null> {
  if (process.platform !== 'win32') return null;
  const bin = path.join(p.slice(0, 3), '$Recycle.Bin', await currentSid());
  let names: string[];
  try {
    names = await fsp.readdir(bin);
  } catch {
    return null;
  }
  let best: { name: string; time: bigint } | null = null;
  for (const n of names) {
    if (!n.startsWith('$I')) continue;
    const buf = await fsp.readFile(path.join(bin, n)).catch(() => null);
    const info = buf && parseRecycleInfo(buf);
    if (info && info.path.toLowerCase() === p.toLowerCase() && (!best || info.time > best.time)) best = { name: n, time: info.time };
  }
  return best ? { data: path.join(bin, `$R${best.name.slice(2)}`), info: path.join(bin, best.name) } : null;
}

/** 휴지통으로 보내기 */
export async function moveToRecycleBin(paths: string[]): Promise<void> {
  await runPowerShell(
    `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
      `foreach ($p in @($rdArgs)) { ` +
      `if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } ` +
      `elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } }`,
    paths,
    120000,
  );
}
