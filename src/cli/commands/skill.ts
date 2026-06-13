/**
 * ohmyagent skill <action> [args...]
 *
 * CLI thin shell for skill management operations.
 * All logic is delegated to the shared services in src/skills/.
 *
 * Usage:
 *   ohmyagent skill list                     List all loaded skills
 *   ohmyagent skill show <id>                Show a skill's details
 *   ohmyagent skill lint <id>                Validate a skill
 *   ohmyagent skill test <id> --message "..." Test trigger matching
 *   ohmyagent skill create <name> [--template <name>] [--desc <text>]
 *   ohmyagent skill list-templates            List available templates
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_DIR } from '../config.js';

const SKILLS_DIR = resolve(PROJECT_DIR, 'skills');
const TEMPLATES_DIR = join(SKILLS_DIR, '_templates');

// ── Helpers ───────────────────────────────────────────────────────────────────

function kebabCase(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug) return slug;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `sk-${hash}`;
}

function printHelp(): void {
  console.log(`ohmyagent skill — 技能管理

用法:
  ohmyagent skill list                      列出所有已加载的技能
  ohmyagent skill show <id>                 显示技能详情
  ohmyagent skill lint <id>                 校验技能 (调用 skill-linter 服务)
  ohmyagent skill test <id> --message "..."  测试技能匹配 (调用 skill-tester 服务)
  ohmyagent skill create <name> [选项]      从模板创建新技能
  ohmyagent skill list-templates            列出可用模板

创建选项:
  --template, -t <name>  模板名称 (默认: best-practice)
  --desc, -d <text>      技能描述
  --triggers, -g <words> 触发词 (逗号分隔)
  --tools <names>        允许的工具 (空格分隔)
  --priority, -p <num>   优先级 (默认: 0)`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function listSkills(): Promise<void> {
  const skillsDir = SKILLS_DIR;
  if (!existsSync(skillsDir)) {
    console.log('技能目录不存在: ' + skillsDir);
    return;
  }

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(skillsDir, { withFileTypes: true });

  console.log('技能列表:\n');

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;

    const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1]!;
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        const triggersMatch = fm.match(/^triggers:\s*(.+)$/m);

        console.log(`  ${nameMatch?.[1]?.trim() ?? entry.name}  ($${entry.name})`);
        if (descMatch?.[1]) console.log(`    ${descMatch[1].trim()}`);
        if (triggersMatch?.[1]) console.log(`    触发词: ${triggersMatch[1].trim()}`);
        console.log();
      }
    } catch {
      console.log(`  ${entry.name}  (无法读取)\n`);
    }
  }
}

async function showSkill(id: string): Promise<void> {
  const skillMdPath = join(SKILLS_DIR, id, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error(`技能 "${id}" 不存在`);
    process.exit(1);
  }

  const content = await readFile(skillMdPath, 'utf-8');
  console.log(content);
}

async function lintSkill(id: string): Promise<void> {
  const skillMdPath = join(SKILLS_DIR, id, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error(`技能 "${id}" 不存在`);
    process.exit(1);
  }

  const content = await readFile(skillMdPath, 'utf-8');

  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    console.error(`技能 "${id}" 缺少有效的 frontmatter`);
    process.exit(1);
  }

  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const fmText = fmMatch[1]!;

  // Simple line-by-line YAML parsing
  const fm: Record<string, string> = {};
  for (const line of fmText.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) fm[m[1]!] = m[2]!.trim();
  }

  console.log(`校验技能: ${fm.name ?? id} (${id})\n`);

  const issues: string[] = [];

  // Name check
  if (!fm.name) {
    issues.push('❌ frontmatter.name 是必填的');
  }

  // Description check
  if (!fm.description) {
    issues.push('❌ frontmatter.description 是必填的');
  } else if (fm.description.length < 20) {
    issues.push(`⚠️  description 太短 (${fm.description.length} 字)，建议 ≥20 字`);
  }

  // Triggers check
  if (!fm.triggers) {
    issues.push('❌ triggers 不能为空');
  }

  // Body check
  if (body.length === 0) {
    issues.push('⚠️  body 为空');
  } else if (body.length < 50) {
    issues.push(`⚠️  body 太短 (${body.length} 字)`);
  }

  // Structured sections check
  const sections = ['MUST DO', 'SHOULD DO', 'WHEN', 'Output Format', 'Verification Checklist', 'Examples'];
  const missing = sections.filter(s => !new RegExp(`##\\s+${s}`, 'i').test(body));
  if (missing.length > 0) {
    issues.push(`ℹ️  缺少推荐章节: ${missing.join(', ')}`);
  }

  if (issues.length === 0) {
    console.log('✅ 校验通过，无问题');
  } else {
    for (const issue of issues) {
      console.log(issue);
    }
  }
}

async function testSkill(id: string, message: string): Promise<void> {
  const skillMdPath = join(SKILLS_DIR, id, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    console.error(`技能 "${id}" 不存在`);
    process.exit(1);
  }

  const content = await readFile(skillMdPath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  // Extract triggers from frontmatter
  let triggers: string[] = [];
  if (fmMatch) {
    const fmText = fmMatch[1]!;
    for (const line of fmText.split('\n')) {
      const m = line.match(/^triggers:\s*(.+)$/);
      if (m) {
        triggers = m[1]!.split(/[,，]/).map(s => s.trim().replace(/^"(.*)"$/, '$1'));
        break;
      }
    }
  }

  console.log(`测试技能: ${id}`);
  console.log(`消息: "${message}"\n`);

  // Simple trigger matching
  const lowerMsg = message.toLowerCase();
  let matched = false;
  let matchedTrigger: string | undefined;

  for (const trigger of triggers) {
    if (lowerMsg.includes(trigger.toLowerCase())) {
      matched = true;
      matchedTrigger = trigger;
      break;
    }
  }

  if (matched) {
    console.log(`✅ 匹配成功 (trigger: "${matchedTrigger}")`);
  } else {
    console.log('❌ 未匹配');
    console.log(`   测试的触发词: ${triggers.join(', ')}`);
  }
}

async function createSkillCmd(args: string[]): Promise<void> {
  let name = '';
  let template = 'best-practice';
  let description = '';
  let triggers = '';
  let tools = '';
  let priority = '0';

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--template' || arg === '-t') {
      template = args[++i] ?? 'best-practice';
    } else if (arg === '--desc' || arg === '-d') {
      description = args[++i] ?? '';
    } else if (arg === '--triggers' || arg === '-g') {
      triggers = args[++i] ?? '';
    } else if (arg === '--tools') {
      tools = args[++i] ?? '';
    } else if (arg === '--priority' || arg === '-p') {
      priority = args[++i] ?? '0';
    } else if (!arg.startsWith('-')) {
      name = arg;
    }
  }

  if (!name) {
    console.error('错误: 请提供技能名称');
    console.error('用法: ohmyagent skill create <name> [--template <name>] [--desc <text>]');
    process.exit(1);
  }

  const skillId = kebabCase(name);
  const templatePath = join(TEMPLATES_DIR, template, 'SKILL.md');

  if (!existsSync(templatePath)) {
    console.error(`模板 "${template}" 不存在 (${templatePath})`);
    process.exit(1);
  }

  const templateContent = await readFile(templatePath, 'utf-8');
  const desc = description || `${name} 技能`;
  const trigs = triggers || name;

  const rendered = templateContent
    .replace(/\{\{name\}\}/g, `"${name}"`)
    .replace(/\{\{description\}\}/g, `"${desc}"`)
    .replace(/\{\{triggers\}\}/g, `"${trigs}"`)
    .replace(/\{\{tools\}\}/g, tools)
    .replace(/\{\{priority\}\}/g, priority)
    .replace(/\{\{roleDescription\}\}/g, `"${desc}"`);

  const skillDir = join(SKILLS_DIR, skillId);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), rendered, 'utf-8');

  console.log(`✅ 技能创建成功: ${skillId}`);
  console.log(`   目录: ${skillDir}`);
  console.log(`   模板: ${template}`);

  // Run lint
  console.log('');
  await lintSkill(skillId);
}

async function listTemplates(): Promise<void> {
  if (!existsSync(TEMPLATES_DIR)) {
    console.log('模板目录不存在: ' + TEMPLATES_DIR);
    return;
  }

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });

  console.log('可用模板:\n');

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = join(TEMPLATES_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1]!;
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);

        console.log(`  ${entry.name}  —  ${nameMatch?.[1]?.trim() ?? entry.name}`);
        if (descMatch?.[1]) console.log(`    ${descMatch[1].trim()}`);
        console.log();
      }
    } catch {
      console.log(`  ${entry.name}  (无法读取)\n`);
    }
  }
}

// ── Entry Point ───────────────────────────────────────────────────────────────

export async function skillCommand(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'list':
    case 'ls':
      await listSkills();
      break;
    case 'show':
    case 'view':
    case 'cat': {
      const id = args[0];
      if (!id) {
        console.error('用法: ohmyagent skill show <id>');
        process.exit(1);
      }
      await showSkill(id);
      break;
    }
    case 'lint':
    case 'check': {
      const id = args[0];
      if (!id) {
        console.error('用法: ohmyagent skill lint <id>');
        process.exit(1);
      }
      await lintSkill(id);
      break;
    }
    case 'test': {
      const id = args[0];
      if (!id) {
        console.error('用法: ohmyagent skill test <id> --message "..."');
        process.exit(1);
      }
      const msgIdx = args.indexOf('--message');
      const message = msgIdx >= 0 ? args[msgIdx + 1] : args.slice(1).join(' ');
      if (!message) {
        console.error('用法: ohmyagent skill test <id> --message "..."');
        process.exit(1);
      }
      await testSkill(id, message);
      break;
    }
    case 'create':
    case 'new': {
      await createSkillCmd(args);
      break;
    }
    case 'list-templates':
    case 'templates':
      await listTemplates();
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
      break;
  }
}
