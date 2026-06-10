import { existsSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { freemem, totalmem, platform, arch } from 'node:os';
import { execSync } from 'node:child_process';
import { resolve as dnsResolve } from 'node:dns';
import { join } from 'node:path';
import { PROJECT_DIR, DATA_DIR, DIST_INDEX, PORT, DB_PATH } from '../config.js';
import { isProcessAlive, readPidFile, checkPortInUse, checkHealthEndpoint, getNodeVersion, isWSL } from '../utils.js';
import { t } from '../i18n.js';

type CheckResult = { status: 'ok' | 'warn' | 'error' | 'info'; label: string; message: string };

const _require = createRequire(import.meta.url);
const results: CheckResult[] = [];

function ok(label: string, msg: string) { results.push({ status: 'ok', label, message: msg }); }
function warn(label: string, msg: string) { results.push({ status: 'warn', label, message: msg }); }
function err(label: string, msg: string) { results.push({ status: 'error', label, message: msg }); }
function info(label: string, msg: string) { results.push({ status: 'info', label, message: msg }); }

function checkSymbol(status: CheckResult['status']): string {
  switch (status) {
    case 'ok': return '\x1b[32m✓\x1b[0m';
    case 'warn': return '\x1b[33m!\x1b[0m';
    case 'error': return '\x1b[31m✗\x1b[0m';
    case 'info': return '\x1b[36m•\x1b[0m';
  }
}

export async function doctorCommand(): Promise<void> {
  console.log(t('doctor.title'));
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // 1. Node.js version
  const nodeVer = getNodeVersion();
  const majorVersion = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
  if (majorVersion >= 20) {
    ok(t('doctor.nodeVersion'), nodeVer);
  } else {
    err(t('doctor.nodeVersion'), `${nodeVer} (>= 20 required)`);
  }

  // 2. Platform
  const platformInfo = `${platform()} (${arch()})${isWSL() ? ' [WSL]' : ''}`;
  info(t('doctor.platform'), platformInfo);

  // 3. pnpm
  try {
    const pnpmVer = execSync('pnpm --version', { encoding: 'utf8' }).trim();
    ok(t('doctor.pnpm'), pnpmVer);
  } catch {
    warn(t('doctor.pnpm'), t('doctor.pnpmMissing'));
  }

  // 4. dist/
  if (existsSync(DIST_INDEX)) {
    ok(t('doctor.dist'), t('doctor.distCompiled'));
  } else {
    err(t('doctor.dist'), t('doctor.distMissing'));
  }

  // 5. config.yaml
  const configYamlPath = join(PROJECT_DIR, 'config.yaml');
  if (existsSync(configYamlPath)) {
    try { readFileSync(configYamlPath, 'utf8'); ok(t('doctor.configYaml'), t('doctor.configReadable')); }
    catch { warn(t('doctor.configYaml'), t('doctor.configUnreadable')); }
  } else {
    warn(t('doctor.configYaml'), t('doctor.configMissing'));
  }

  // 6. .env
  const envPath = join(PROJECT_DIR, '.env');
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf8');
      if (/PI_AI_API_KEY\s*=\s*\S+/.test(content)) {
        ok(t('doctor.dotEnv'), t('doctor.dotEnvOk'));
      } else {
        warn(t('doctor.dotEnv'), t('doctor.dotEnvWarn'));
      }
    } catch {
      warn(t('doctor.dotEnv'), t('doctor.dotEnvUnreadable'));
    }
  } else {
    err(t('doctor.dotEnv'), t('doctor.dotEnvMissing'));
  }

  // 7. Port
  const portUsed = await checkPortInUse();
  if (!portUsed) {
    ok(t('doctor.port', { port: PORT }), t('doctor.portAvailable'));
  } else {
    const pid = readPidFile();
    if (pid && isProcessAlive(pid)) {
      info(t('doctor.port', { port: PORT }), t('doctor.portOwned'));
    } else {
      warn(t('doctor.port', { port: PORT }), t('doctor.portOccupied'));
    }
  }

  // 8. Health endpoint
  const healthy = await checkHealthEndpoint();
  if (healthy) {
    ok(t('doctor.health'), t('doctor.healthOk'));
  } else if (!portUsed) {
    info(t('doctor.health'), t('doctor.healthSkipped'));
  } else {
    warn(t('doctor.health'), t('doctor.healthNoResponse'));
  }

  // 9. Native modules
  let betterSqlite3Ok = true;
  try { _require.resolve('better-sqlite3'); ok(t('doctor.betterSqlite3'), t('doctor.moduleOk')); }
  catch { betterSqlite3Ok = false; err(t('doctor.betterSqlite3'), t('doctor.moduleFail')); }

  try { _require.resolve('sharp'); ok(t('doctor.sharp'), t('doctor.moduleOk')); }
  catch { warn(t('doctor.sharp'), t('doctor.sharpFail')); }

  // 10. Database
  if (betterSqlite3Ok) {
    try {
      const Database = _require('better-sqlite3');
      mkdirSync(DATA_DIR, { recursive: true });
      const testDb = new Database(join(DATA_DIR, '.doctor-test.db'));
      testDb.exec('SELECT 1');
      testDb.close();
      try { unlinkSync(join(DATA_DIR, '.doctor-test.db')); } catch {}
      ok(t('doctor.db'), t('doctor.dbWritable'));
    } catch (e: any) {
      err(t('doctor.db'), `${t('doctor.dbFail')}: ${e.message}`);
    }
  } else {
    info(t('doctor.db'), t('doctor.dbSkipped'));
  }

  // 11. Disk space
  try {
    if (typeof _require('node:fs').statfsSync === 'function') {
      const fsStats = _require('node:fs').statfsSync(DATA_DIR);
      const freeGB = Math.round((fsStats.bfree * fsStats.bsize) / (1024 * 1024 * 1024));
      if (freeGB > 5) {
        ok(t('doctor.disk'), t('doctor.diskFree', { size: freeGB }));
      } else {
        warn(t('doctor.disk'), t('doctor.diskLow', { size: freeGB }));
      }
    } else {
      info(t('doctor.disk'), t('doctor.diskUnknown'));
    }
  } catch { info(t('doctor.disk'), t('doctor.diskUnknown')); }

  // 12. Memory
  const freeMB = Math.round(freemem() / (1024 * 1024));
  const totalMB = Math.round(totalmem() / (1024 * 1024));
  if (freeMB > 512) {
    ok(t('doctor.memory'), t('doctor.memoryOk', { free: freeMB, total: totalMB }));
  } else {
    warn(t('doctor.memory'), t('doctor.memoryLow', { free: freeMB, total: totalMB }));
  }

  // 13. Network
  try {
    await new Promise<void>((res, rej) => {
      dnsResolve('dns.google', (error: any) => { if (error) rej(error); else res(); });
    });
    ok(t('doctor.network'), t('doctor.networkOk'));
  } catch {
    warn(t('doctor.network'), t('doctor.networkFail'));
  }

  // 14. Service status
  const svcPid = readPidFile();
  if (svcPid && isProcessAlive(svcPid)) {
    const portCheck = await checkPortInUse();
    if (portCheck) {
      ok(t('doctor.service'), t('doctor.serviceRunning', { pid: svcPid }));
    } else {
      warn(t('doctor.service'), t('doctor.serviceAliveNoPort', { port: PORT }));
    }
  } else {
    info(t('doctor.service'), t('doctor.serviceNotRunning'));
  }

  // Output
  console.log('');
  for (const r of results) {
    console.log(`  ${checkSymbol(r.status)}  ${r.label.padEnd(16)} ${r.message}`);
  }

  // Summary
  const errors = results.filter((r) => r.status === 'error');
  const warnings = results.filter((r) => r.status === 'warn');

  if (errors.length > 0 || warnings.length > 0) {
    console.log('');
    console.log(t('doctor.fixHints'));
    for (const e of errors) console.log(`  - [ERROR] ${e.label}: ${e.message}`);
    for (const w of warnings) console.log(`  - [WARN] ${w.label}: ${w.message}`);
  } else {
    console.log('');
    console.log('\x1b[32m' + t('doctor.allOk') + '\x1b[0m');
  }

  console.log('');
}
