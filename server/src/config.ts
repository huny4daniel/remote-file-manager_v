import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  /** 접속을 허용할 IPv4 CIDR 목록. 비어 있으면 모두 허용 */
  allowedIps: string[];
  shell: string;
  claudeCommand: string;
  scrollbackBytes: number;
}

const defaults: Config = {
  host: '0.0.0.0',
  port: 7420,
  allowedIps: ['127.0.0.1/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  shell: 'powershell.exe',
  claudeCommand: 'claude',
  scrollbackBytes: 512 * 1024,
};

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(): Config {
  const file = path.join(rootDir, 'config.json');
  let user: Partial<Config> = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cfg = { ...defaults, ...user };
  if (process.env.REMOTE_FILE_HOST) cfg.host = process.env.REMOTE_FILE_HOST;
  if (process.env.REMOTE_FILE_PORT) cfg.port = Number(process.env.REMOTE_FILE_PORT);
  return cfg;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function makeIpFilter(cidrs: string[]): (ip: string | undefined) => boolean {
  if (cidrs.length === 0) return () => true;
  const ranges = cidrs.map((c) => {
    const [base, bitsStr] = c.split('/');
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { net: (ipToInt(base) ?? 0) & mask, mask };
  });
  return (raw) => {
    if (!raw) return false;
    let ip = raw;
    if (ip === '::1') ip = '127.0.0.1';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    const n = ipToInt(ip);
    if (n === null) return false;
    return ranges.some((r) => ((n & r.mask) >>> 0) === r.net);
  };
}
