import { existsSync } from 'node:fs';
import { PID_FILE, PORT, LOG_FILE } from '../config.js';
import { isProcessAlive, readPidFile, checkHealthEndpoint, getProcessUptime, getProcessMemory, findProcessByPort } from '../utils.js';
import { t } from '../i18n.js';

export async function statusCommand(): Promise<void> {
  console.log('OhMyAgent Status');
  console.log('═══════════════════════════════════');

  const pid = readPidFile();
  const healthy = await checkHealthEndpoint();

  if (healthy) {
    const effectivePid = (pid && isProcessAlive(pid)) ? pid : findProcessByPort();
    console.log(`  Status:     \x1b[32m${t('status.running')}\x1b[0m`);
    if (effectivePid) {
      console.log(`  ${t('status.pidLabel')}:        ${effectivePid}`);
      const uptime = getProcessUptime(effectivePid);
      if (uptime !== 'unknown') console.log(`  ${t('status.uptime')}:     ${uptime}`);
      const memory = getProcessMemory(effectivePid);
      if (memory !== 'unknown') console.log(`  ${t('status.memory')}:     ${memory}`);
    }
    console.log(`  ${t('status.port')} ${PORT}:  ${t('status.portListening')}`);
    console.log(`  /health:    \x1b[32m${t('status.healthOk')}\x1b[0m`);
    console.log(`  ${t('status.logFile')}:   ${LOG_FILE}`);
    if (pid) {
      console.log(`  ${t('status.pidFile')}:   ${PID_FILE}`);
    } else {
      console.log(`  ${t('status.pidFile')}:   ${t('status.pidFileNone')}`);
      // Hint at native service manager
      if (existsSync('/data/data/com.termux') || process.env.PREFIX) {
        console.log(`  Manager:    runit (use sv)`);
      } else if (process.platform === 'linux') {
        console.log(`  Manager:    systemd (use systemctl)`);
      } else if (process.platform === 'win32') {
        console.log(`  Manager:    Task Scheduler (use schtasks or taskschd.msc)`);
      } else if (process.platform === 'darwin') {
        console.log(`  Manager:    launchd (use launchctl)`);
      }
    }
    console.log('');
    return;
  }

  if (pid && isProcessAlive(pid)) {
    console.log(`  Process:    ${t('status.processAliveNoPort', { pid })}`);
    console.log(`  /health:    \x1b[31m${t('status.healthUnreachable')}\x1b[0m`);
    console.log('');
    return;
  }

  console.log(`  Status:     ${t('status.notRunning')}`);
  console.log('');
  if (pid) {
    console.log(`  ${t('status.pidFileStale')}`);
  } else {
    console.log(`  ${t('status.startHint')}`);
  }
  console.log('');
}
