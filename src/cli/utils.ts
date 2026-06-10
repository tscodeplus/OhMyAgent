import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { execSync } from 'node:child_process';
import { PID_FILE, PORT, PROJECT_DIR, DIST_INDEX } from './config.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

export function checkPortInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(PORT, '127.0.0.1');
  });
}

export function checkHealthEndpoint(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { hostname: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export function quickPreflight(): boolean {
  if (!existsSync(DIST_INDEX)) {
    console.error(`\x1b[31m[ERROR]\x1b[0m dist/src/index.js 不存在，请先运行 pnpm build`);
    console.error(`  路径: ${DIST_INDEX}`);
    return false;
  }
  return true;
}

export function findProcessByPort(): number | null {
  try {
    const platform = process.platform;
    let stdout: string;

    if (platform === 'win32') {
      stdout = execSync(`netstat -ano | findstr ":${PORT}"`, { encoding: 'utf8' });
      const match = stdout.match(/LISTENING\s+(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    } else {
      stdout = execSync(`lsof -ti :${PORT} 2>/dev/null || fuser ${PORT}/tcp 2>/dev/null`, { encoding: 'utf8' });
      const pid = parseInt(stdout.trim(), 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
}

export function getProcessUptime(pid: number): string {
  try {
    const platform = process.platform;
    let stdout: string;

    if (platform === 'win32') {
      // Use elapsed time via wmic to avoid PowerShell version issues
      try {
        stdout = execSync(
          `wmic process where ProcessId=${pid} get CreationDate /format:value`,
          { encoding: 'utf8', stdio: 'pipe' },
        ).trim();
        const match = stdout.match(/CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d+)/);
        if (match) {
          const startTime = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7]}`).getTime();
          if (!isNaN(startTime)) {
            return formatDuration(Date.now() - startTime);
          }
        }
      } catch { /* fall through */ }
      return 'unknown';
    } else {
      stdout = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (!stdout) return '未知';
      return stdout;
    }
  } catch {
    return '未知';
  }
}

export function getProcessMemory(pid: number): string {
  try {
    const platform = process.platform;
    let stdout: string;

    if (platform === 'win32') {
      stdout = execSync(`powershell -Command "(Get-Process -Id ${pid}).WorkingSet64 / 1MB"`, { encoding: 'utf8' });
      const mb = parseInt(stdout.trim(), 10);
      return isNaN(mb) ? '未知' : `${mb} MB`;
    } else if (platform === 'darwin') {
      stdout = execSync(`ps -p ${pid} -o rss= 2>/dev/null`, { encoding: 'utf8' });
      const kb = parseInt(stdout.trim(), 10);
      return isNaN(kb) ? '未知' : `${Math.round(kb / 1024)} MB`;
    } else {
      stdout = execSync(`ps -p ${pid} -o rss= 2>/dev/null`, { encoding: 'utf8' });
      const kb = parseInt(stdout.trim(), 10);
      return isNaN(kb) ? '未知' : `${Math.round(kb / 1024)} MB`;
    }
  } catch {
    return '未知';
  }
}

export function getNodeVersion(): string {
  return process.version;
}

export function isWSL(): boolean {
  try {
    const { existsSync: exists } = require('node:fs');
    return process.platform === 'linux' && exists('/proc/sys/fs/binfmt_misc/WSLInterop');
  } catch {
    return false;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
