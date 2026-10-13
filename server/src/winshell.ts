import { execFile } from 'node:child_process';
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

export function resolveShortcut(lnk: string): Promise<string> {
  return runPowerShell(`(New-Object -ComObject WScript.Shell).CreateShortcut($rdArgs).TargetPath`, lnk);
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
