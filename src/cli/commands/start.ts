import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { PROJECT_DIR, DIST_INDEX, PID_FILE, LOG_FILE, LOG_DIR, PORT } from '../config.js';
import { isProcessAlive, readPidFile, checkPortInUse, quickPreflight, sleep } from '../utils.js';
import { t } from '../i18n.js';

function killTmuxSession(): void {
  try {
    execSync('tmux kill-session -t ohmyagent 2>/dev/null', { stdio: 'ignore' });
  } catch { /* not running or tmux not installed */ }
}

function startViaService(): boolean {
  // macOS launchd
  try { execSync('launchctl load ~/Library/LaunchAgents/com.ohmyagent.plist 2>/dev/null', { stdio: 'ignore' }); return true; } catch {}
  // Linux systemd
  try { execSync('systemctl --user start ohmyagent 2>/dev/null', { stdio: 'ignore' }); return true; } catch {}
  // Windows Task Scheduler
  try { execSync('schtasks /Run /TN "OhMyAgent" 2>nul', { stdio: 'ignore' }); return true; } catch {}
  // Termux runit
  try { execSync('sv up ohmyagent 2>/dev/null', { stdio: 'ignore' }); return true; } catch {}
  return false;
}

function hasServiceInstalled(): boolean {
  const platform = process.platform;
  const isTermux = existsSync('/data/data/com.termux') || !!process.env.PREFIX;
  if (platform === 'darwin') {
    try { execSync('launchctl list com.ohmyagent 2>/dev/null', { stdio: 'ignore' }); return true; } catch { return false; }
  }
  if (isTermux) {
    try { execSync('sv status ohmyagent 2>/dev/null', { stdio: 'ignore' }); return true; } catch { return false; }
  }
  if (platform === 'linux') {
    try { execSync('systemctl --user is-enabled ohmyagent 2>/dev/null', { stdio: 'ignore' }); return true; } catch { return false; }
  }
  if (platform === 'win32') {
    try { execSync('schtasks /Query /TN "OhMyAgent" 2>nul', { stdio: 'ignore' }); return true; } catch { return false; }
  }
  return false;
}

export async function startCommand(): Promise<void> {
  if (!quickPreflight()) {
    process.exit(1);
  }

  // If a system service is installed, use it instead of spawning a new process
  if (hasServiceInstalled()) {
    console.log('System service detected, starting via service manager...');
    if (startViaService()) {
      await sleep(3000);
      const healthy = await checkPortInUse();
      if (healthy) {
        console.log(`\x1b[32m[INFO]\x1b[0m Service started (port ${PORT})`);
      } else {
        console.log('Service start requested — it may take a few seconds.');
        console.log(`  Check: ohmyagent status`);
      }
      return;
    }
    console.log('Failed to start via service manager, falling back to direct mode.');
  }

  killTmuxSession();

  const existingPid = readPidFile();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(t('start.alreadyRunning', { pid: existingPid }));
    return;
  }

  if (existingPid && existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }

  const portInUse = await checkPortInUse();
  if (portInUse) {
    console.error(`\x1b[31m[ERROR]\x1b[0m ` + t('start.portInUse', { port: PORT }));
    console.error('  ' + t('start.portInUseHint'));
    process.exit(1);
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const child = spawn('node', [DIST_INDEX], {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_DIR,
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const pid = child.pid!;
  writeFileSync(PID_FILE, String(pid));
  child.unref();

  console.log(t('start.starting', { pid }));

  let healthy = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(3000);
    if (!isProcessAlive(pid)) {
      console.error('\x1b[31m[ERROR]\x1b[0m ' + t('start.failedExited'));
      console.error('  ' + t('start.checkLogs', { log: LOG_FILE }));
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      process.exit(1);
    }
    healthy = await checkPortInUse();
    if (healthy) break;
    if (attempt < 5) {
      console.log('  ' + t('start.waitingPort', { elapsed: attempt * 3 }));
    }
  }

  if (!healthy) {
    console.error('\x1b[31m[ERROR]\x1b[0m ' + t('start.failedNoPort'));
    console.error('  ' + t('start.checkLogs', { log: LOG_FILE }));
    process.exit(1);
  }

  console.log(`\x1b[32m[INFO]\x1b[0m ` + t('start.started'));
  console.log(`  PID:  ${pid}`);
  console.log(`  ${t('start.logLabel')}: ${LOG_FILE}`);
  console.log(`  ${t('start.portLabel')}: ${PORT}`);
}
