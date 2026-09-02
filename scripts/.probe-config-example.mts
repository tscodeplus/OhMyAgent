import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { loadConfig } from '../src/app/config.js';

const src = readFileSync('config.yaml.example', 'utf8').split('\n');
const isContent = (l: string) => /^#(\s*#)*\s*([a-z][a-zA-Z0-9_]*:|- )/.test(l);
const out: string[] = [];
for (const line of src) {
  if (!isContent(line)) {
    if (!line.startsWith('#')) out.push(line);
    continue;
  }
  const m = line.match(/^#(\s*)(.*)$/)!;
  const indent = Math.max(0, m[1].length - 1);
  let rest = m[2];
  while (rest.startsWith('# ')) rest = rest.slice(2);
  if (rest.startsWith('#')) rest = rest.slice(1);
  out.push(' '.repeat(indent) + rest.replace(/^\s+/, ''));
}
const text = out.join('\n');
writeFileSync('/tmp/oma-max-config.yaml', text);
const doc = yaml.load(text) as Record<string, unknown>;
console.log('TOP-LEVEL:', Object.keys(doc).sort().join(' '));
const cfg = loadConfig(
  { OHMYAGENT_HOME: '/tmp/oma-probe-home' } as NodeJS.ProcessEnv,
  '/tmp/oma-max-config.yaml',
);
console.log('VALIDATED OK');
console.log('piAi=', JSON.stringify(cfg.piAi));
console.log(
  'telegram.enabled=',
  cfg.telegram?.enabled,
  'botToken len=',
  cfg.telegram?.botToken?.length,
);
console.log('computerUse.ssh=', JSON.stringify(cfg.computerUse?.ssh));
console.log('memory.autoCompress=', JSON.stringify(cfg.memory.autoCompress));
console.log('harness.trigger=', JSON.stringify(cfg.harness?.trigger));
console.log('footer=', JSON.stringify(cfg.footer));
console.log('rateLimit=', JSON.stringify(cfg.rateLimit));
console.log('agents=', (cfg.agents ?? []).map((a) => a.id).join(','));
console.log('customProviders=', (cfg.customProviders ?? []).map((p) => p.provider).join(','));
