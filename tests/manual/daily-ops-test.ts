import { SQLiteApprovalGate } from '../../src/tools/approval-gate.js';
import { normalizeCommand } from '../../src/tools/shell-command-policy.js';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { ApprovalPolicyRepository } from '../../src/memory/repositories/approval-policy-repository.js';

const db = new Database(':memory:');
applySchema(db);
const repo = new ApprovalPolicyRepository(db);
const gate = new SQLiteApprovalGate(repo, {
  execMode: 'balanced',
  shellAllowlist: ['adb','date','ls','pwd','whoami','uname','echo','cat','head','tail','wc','grep','find','which','env','printenv'],
});

const tests: Array<[string, string]> = [
  ['每日操作', 'cp file.txt /tmp/'],
  ['每日操作', 'cp -r dir/ /tmp/'],
  ['每日操作', 'mv file.txt /tmp/'],
  ['每日操作', 'mkdir newdir'],
  ['每日操作', 'touch newfile.txt'],
  ['每日操作', 'diff file1 file2'],
  ['每日操作', 'du -sh .'],
  ['每日操作', 'df -h'],
  ['每日操作', 'ping -c 1 google.com'],
  ['每日操作', 'file unknown.bin'],
  ['每日操作', 'stat /etc/hosts'],
  ['每日操作', 'md5sum file.txt'],
  ['每日操作', 'sed s/foo/bar/ file'],
  ['每日操作', 'sed -i s/foo/bar/ file'],
  ['每日操作', 'nano file.txt'],
  ['每日操作', 'ln -s target link'],
  ['每日操作', 'tee output.log'],
  ['危险操作', 'cp -r /etc /tmp/'],
  ['危险操作', 'mv file /etc/cron.d/'],
  ['危险操作', 'sed -i s/x/y/ /etc/hosts'],
  ['危险操作', 'nano /etc/passwd'],
  ['危险操作', 'tee /etc/nginx/conf'],
];

async function main() {
  for (const [cat, cmd] of tests) {
    const r = await gate.evaluate({ kind: 'shell', command: normalizeCommand(cmd), sessionKey: 's', scope: 'global' });
    const e = {approved:'✅',rejected:'❌',requires_approval:'⏳'}[r];
    console.log(`${e} [${cat}] ${cmd}`);
  }
  db.close();
}
main();
