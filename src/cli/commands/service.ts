import { existsSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PROJECT_DIR, DIST_INDEX } from '../config.js';
import { t } from '../i18n.js';

function isTermux(): boolean {
  return existsSync('/data/data/com.termux') || !!process.env.PREFIX;
}

function checkDep(name: string, howToInstall: string): boolean {
  try {
    execSync(`command -v ${name} 2>/dev/null || which ${name} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    console.error(`\x1b[31m[ERROR]\x1b[0m ` + t('service.depMissing', { cmd: name }));
    console.error('  ' + t('service.depInstall', { how: howToInstall }));
    return false;
  }
}

export async function serviceCommand(action: 'install' | 'uninstall'): Promise<void> {
  if (isTermux()) {
    await termuxService(action);
    return;
  }

  const platform = process.platform;
  if (platform === 'linux') { await linuxService(action); }
  else if (platform === 'darwin') { await darwinService(action); }
  else if (platform === 'win32') { await windowsService(action); }
  else { console.error(t('service.unsupportedPlatform', { platform })); process.exit(1); }
}

// ─── Linux systemd ───

async function linuxService(action: 'install' | 'uninstall'): Promise<void> {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  const serviceFile = join(serviceDir, 'ohmyagent.service');
  const nodeBin = process.execPath;

  if (action === 'install') {
    if (!checkDep('systemctl', 'systemd (included in most Linux distros)')) return;
    mkdirSync(serviceDir, { recursive: true });

    const unit = `[Unit]
Description=OhMyAgent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBin} ${DIST_INDEX}
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
    writeFileSync(serviceFile, unit);
    console.log(t('service.systemdWrote', { path: serviceFile }));

    try {
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync('systemctl --user enable ohmyagent', { stdio: 'inherit' });
      execSync('systemctl --user start ohmyagent', { stdio: 'inherit' });
      console.log('');
      console.log('\x1b[32m[INFO]\x1b[0m ' + t('service.systemdInstalled'));
      console.log('');
      console.log('  ' + t('service.systemdManage'));
      console.log('    systemctl --user status ohmyagent');
      console.log('    systemctl --user stop ohmyagent');
      console.log('    systemctl --user restart ohmyagent');
      console.log('    journalctl --user -u ohmyagent -f');
    } catch {
      console.error('\x1b[31m[ERROR]\x1b[0m ' + t('service.systemdFailed'));
      console.log('  systemctl --user enable --now ohmyagent');
    }
  } else {
    try { execSync('systemctl --user stop ohmyagent', { stdio: 'inherit' }); } catch {}
    try { execSync('systemctl --user disable ohmyagent', { stdio: 'inherit' }); } catch {}
    if (existsSync(serviceFile)) {
      unlinkSync(serviceFile);
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      console.log(t('service.systemdRemoved'));
    } else {
      console.log(t('service.systemdNotInstalled'));
    }
  }
}

// ─── macOS launchd ───

async function darwinService(action: 'install' | 'uninstall'): Promise<void> {
  const plistDir = join(homedir(), 'Library', 'LaunchAgents');
  const plistFile = join(plistDir, 'com.ohmyagent.plist');
  const nodeBin = process.execPath;

  if (action === 'install') {
    if (!checkDep('launchctl', 'launchd (built into macOS)')) return;
    mkdirSync(plistDir, { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>com.ohmyagent</string>
    <key>ProgramArguments</key><array><string>${nodeBin}</string><string>${DIST_INDEX}</string></array>
    <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${join(homedir(), '.ohmyagent', 'data', 'logs', 'stdout.log')}</string>
    <key>StandardErrorPath</key><string>${join(homedir(), '.ohmyagent', 'data', 'logs', 'stderr.log')}</string>
    <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
</dict></plist>`;
    writeFileSync(plistFile, plist);
    console.log(t('service.launchdWrote', { path: plistFile }));

    try {
      execSync(`launchctl load "${plistFile}"`, { stdio: 'inherit' });
      console.log('');
      console.log('\x1b[32m[INFO]\x1b[0m ' + t('service.launchdInstalled'));
      console.log('  launchctl list | grep ohmyagent');
      console.log(`  launchctl unload "${plistFile}"`);
      console.log(`  launchctl load "${plistFile}"`);
    } catch {
      console.error('\x1b[31m[ERROR]\x1b[0m ' + t('service.launchdFailed'));
    }
  } else {
    try { execSync(`launchctl unload "${plistFile}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    if (existsSync(plistFile)) { unlinkSync(plistFile); console.log(t('service.launchdRemoved')); }
    else { console.log(t('service.launchdNotInstalled')); }
  }
}

// ─── Windows Task Scheduler (At Logon) ───
// Runs in user session — no Session 0 isolation, Computer Use works fully

async function windowsService(action: 'install' | 'uninstall'): Promise<void> {
  const taskName = 'OhMyAgent';
  const nodeBin = process.execPath;

  if (action === 'install') {
    // Check admin
    try {
      execSync('schtasks /?', { stdio: 'ignore' });
    } catch {
      console.error('\x1b[31m[ERROR]\x1b[0m Administrator privileges required.');
      console.error('  Restart your terminal as Administrator and try again.');
      return;
    }

    // Write a VBS launcher that runs node hidden (no terminal window)
    const vbsFile = join(PROJECT_DIR, 'start-ohmyagent.vbs');
    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.CurrentDirectory = "${PROJECT_DIR}"`,
      `WshShell.Run """${nodeBin}"" ""${DIST_INDEX}""", 0, False`,
    ].join('\r\n');
    writeFileSync(vbsFile, vbsContent);

    // Create Task Scheduler task — runs at logon in user session, hidden
    const result = spawnSync('schtasks', [
      '/Create', '/SC', 'ONLOGON', '/TN', taskName,
      '/TR', `wscript.exe "${vbsFile}"`,
      '/F', '/RL', 'HIGHEST', '/IT',
      '/DELAY', '0000:30',
    ], { stdio: 'inherit' });
    if (result.status !== 0) {
      const errMsg = result.stderr?.toString() || '';
      console.error('\x1b[31m[ERROR]\x1b[0m ' + t('service.taskFailed'));
      if (errMsg.includes('Access is denied') || errMsg.includes('拒绝访问')) {
        console.error('  Administrator privileges required.');
      } else {
        console.error('  ' + errMsg.trim());
      }
      return;
    }

    // Start immediately
    spawnSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'ignore' });

    console.log('');
    console.log('\x1b[32m[INFO]\x1b[0m Scheduled task created (runs at logon)');
    console.log('  Runs in user session — Computer Use fully available.');
    console.log('');
    console.log('  Manage with:');
    console.log('    schtasks /Query /TN "OhMyAgent"   # Status');
    console.log('    schtasks /Run /TN "OhMyAgent"     # Start');
    console.log('    schtasks /End /TN "OhMyAgent"     # Stop');
    console.log('    taskschd.msc                      # GUI');
  } else {
    // Remove Task Scheduler task
    try { execSync('schtasks /End /TN "OhMyAgent" 2>nul', { stdio: 'ignore' }); } catch {}
    try { execSync('schtasks /Delete /TN "OhMyAgent" /F', { stdio: 'inherit' }); console.log('Scheduled task removed'); }
    catch { console.log('Scheduled task was not found'); }
    // Also remove old WinSW service if present (from previous version)
    try { execSync('sc stop OhMyAgent 2>nul', { stdio: 'ignore' }); } catch {}
    try { execSync('sc delete OhMyAgent 2>nul', { stdio: 'ignore' }); } catch {}
    // Clean up launcher files from both old and new installs
    for (const f of ['start-ohmyagent.vbs', 'start-ohmyagent.bat', 'ohmyagent-service.exe', 'ohmyagent-service.xml', 'ohmyagent-service.ps1']) {
      const fp = join(PROJECT_DIR, f);
      try { if (existsSync(fp)) unlinkSync(fp); } catch {}
    }
  }
}

// ─── Termux runit (sv) ───

async function termuxService(action: 'install' | 'uninstall'): Promise<void> {
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const serviceDir = join(prefix, 'var', 'service', 'ohmyagent');
  const runScript = join(serviceDir, 'run');
  const logDir = join(serviceDir, 'log');
  const logScript = join(logDir, 'run');

  if (action === 'install') {
    if (!checkDep('sv', 'termux-services: pkg install termux-services')) return;
    mkdirSync(serviceDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(runScript, `#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock >/dev/null 2>&1 || true
export ANDROID_NDK_HOME=${prefix}
export npm_config_nodedir=${prefix}
cd ${PROJECT_DIR}
exec ${process.execPath} dist/src/index.js 2>&1
`);
    execSync(`chmod +x "${runScript}"`, { stdio: 'ignore' });

    writeFileSync(logScript, `#!/data/data/com.termux/files/usr/bin/bash
exec svlogd -tt ${PROJECT_DIR}/data/logs/
`);
    execSync(`chmod +x "${logScript}"`, { stdio: 'ignore' });

    console.log(t('service.runitWrote', { path: serviceDir }));
    try {
      execSync(`SVDIR=${prefix}/var/service sv up ohmyagent`, { stdio: 'inherit' });
      console.log('');
      console.log('\x1b[32m[INFO]\x1b[0m ' + t('service.runitInstalled'));
      console.log('');
      console.log(`  SVDIR=${prefix}/var/service`);
      console.log('  sv status ohmyagent');
      console.log('  sv up/down/restart ohmyagent');
    } catch (e: any) {
      console.error('\x1b[31m[ERROR]\x1b[0m ' + t('service.runitFailed'));
      console.error(`  ${e.message}`);
      console.log(`  Run manually: SVDIR=${prefix}/var/service sv up ohmyagent`);
    }
  } else {
    try { execSync(`SVDIR=${prefix}/var/service sv down ohmyagent 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    if (existsSync(runScript)) {
      try { unlinkSync(logScript); unlinkSync(runScript); rmdirSync(logDir); rmdirSync(serviceDir); console.log(t('service.runitRemoved')); }
      catch (e: any) { console.error(`\x1b[31m[ERROR]\x1b[0m Failed: ${e.message}`); }
    } else {
      console.log(t('service.runitNotInstalled'));
    }
  }
}
