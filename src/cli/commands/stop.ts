import { existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PID_FILE } from '../config.js';
import { isProcessAlive, readPidFile, findProcessByPort, sleep } from '../utils.js';
import { t } from '../i18n.js';

function killTmuxSession(): boolean {
  try {
    execSync('tmux kill-session -t ohmyagent 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasTmuxSession(): boolean {
  try {
    execSync('tmux has-session -t ohmyagent 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function stopSystemdService(): boolean {
  try {
    execSync('systemctl --user stop ohmyagent 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasSystemdService(): boolean {
  // Termux has a systemctl shim but no real systemd
  if (existsSync('/data/data/com.termux') || process.env.PREFIX) return false;
  try {
    execSync('systemctl --user is-active ohmyagent 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function stopTaskScheduler(): boolean {
  try {
    execSync('schtasks /End /TN "OhMyAgent" 2>nul', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasTaskScheduler(): boolean {
  try {
    const result = execSync('schtasks /Query /TN "OhMyAgent" 2>nul', { stdio: 'pipe', encoding: 'utf8' });
    return result.includes('OhMyAgent');
  } catch {
    return false;
  }
}

export async function stopCommand(): Promise<void> {
  // Stop Task Scheduler first (before killing the process)
  if (process.platform === 'win32' && hasTaskScheduler()) {
    console.log('Scheduled task detected, stopping...');
    if (!stopTaskScheduler()) {
      console.log('  (may need Administrator privileges)');
    }
  }

  // Stop systemd first
  if (hasSystemdService()) {
    console.log('systemd service detected, stopping...');
    stopSystemdService();
  }

  // Stop runit (sv) on Termux
  if (existsSync('/data/data/com.termux') || process.env.PREFIX) {
    try {
      execSync('sv force-stop ohmyagent 2>/dev/null', { stdio: 'ignore' });
      console.log('runit service stopped');
    } catch {}
  }

  // Kill tmux session to prevent auto-restart
  if (hasTmuxSession()) {
    killTmuxSession();
    console.log(t('stop.tmuxCleared'));
  }

  let pid = readPidFile();

  if (!pid || !isProcessAlive(pid)) {
    if (pid && existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    pid = findProcessByPort();
    if (!pid) {
      console.log(t('stop.notRunning'));
      return;
    }
  }

  console.log(t('stop.stopping', { pid }));

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    console.log(t('stop.stopped'));
    return;
  }

  let stopped = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (!isProcessAlive(pid)) {
      stopped = true;
      break;
    }
  }

  if (!stopped) {
    if (process.platform === 'win32') {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch { /* ok */ }
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ok */ }
    }
    await sleep(500);
  }

  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }

  console.log(t('stop.stopped'));
}
