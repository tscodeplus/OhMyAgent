import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Manifest, ToolsConfig, MemoryPolicy } from './skill-schema.js';
import type { ApprovalOverride, ToolProfileId } from '../app/types.js';

// ── LoadedSkill type ────────────────────────────────────────────────────────

/** L3 resource paths collected from the skill directory */
export interface SkillResources {
  scripts?: string[];
  references?: string[];
  assets?: string[];
}

export interface LoadedSkill {
  manifest: Manifest;
  promptContent: string;
  tools: ToolsConfig;
  memoryPolicy: MemoryPolicy;
  approvalOverrides?: ApprovalOverride[];
  toolsProfile?: ToolProfileId;
  path: string;
  /** Paths to L3 resource directories (relative to skill root) */
  resources?: SkillResources;
}

// ── AgentSkills.io Frontmatter Schema ───────────────────────────────────────

export const FrontmatterSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

// ── Constants ───────────────────────────────────────────────────────────────

const PROMPT_FILE = 'SKILL.md';

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { attrs: Record<string, unknown>; body: string } | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') { endIndex = i; break; }
  }
  if (endIndex === -1) return null;

  const yamlBlock = lines.slice(1, endIndex).join('\n');
  const body = lines.slice(endIndex + 1).join('\n');
  const parsed = parseYaml(yamlBlock);
  if (typeof parsed !== 'object' || parsed === null) return null;

  return { attrs: stripNulls(parsed as Record<string, unknown>), body };
}

/** YAML maps empty values to null, but zod .optional() only accepts undefined. */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) {
      result[key] = value;
    }
  }
  return result;
}

/** Check if a string contains CJK characters. */
function hasCJK(s: string): boolean {
  return /[一-鿿㐀-䶿　-〿＀-￯]/.test(s);
}

/**
 * Generate trigger words for a skill.
 *
 * Priority:
 * 1. Explicit triggers in metadata (comma-separated)
 * 2. Derive from name: full name + individual words + CJK bigrams
 */
function generateTriggers(name: string, metadata?: Record<string, unknown>): string[] {
  // Priority 1: explicit triggers in metadata
  if (metadata?.triggers) {
    const raw = String(metadata.triggers);
    // Split by commas (and Chinese commas) first, then trim each entry.
    // Previously split by /[,，\s]+/ which broke multi-word triggers like
    // "todo list" into two separate single-word triggers.
    return raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  }

  // Priority 2: derive from name
  const triggers = new Set<string>();
  triggers.add(name.toLowerCase());
  const parts = name.toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(p => p.length >= 2);
  for (const p of parts) triggers.add(p);

  // For CJK names, add character bigrams as additional triggers.
  // Without word boundaries, the full CJK name often fails to match in
  // natural messages (e.g. trigger "日程管理" won't match "帮我管理日程").
  // Bigrams like "日程" and "管理" catch partial mentions.
  if (hasCJK(name)) {
    const cleaned = name.replace(/\s+/g, '');
    for (let i = 0; i < cleaned.length - 1; i++) {
      const bigram = cleaned.slice(i, i + 2);
      if (bigram.length === 2) triggers.add(bigram.toLowerCase());
    }
  }

  return [...triggers];
}

/** Scan subdirectories for AgentSkills.io L3 resource files */
async function scanResources(absolutePath: string): Promise<SkillResources | undefined> {
  const result: SkillResources = {};
  let found = false;

  const resourceDirs = ['scripts', 'references', 'assets'] as const;
  for (const dirName of resourceDirs) {
    try {
      const entries = await readdir(join(absolutePath, dirName), { withFileTypes: true });
      const files = entries.filter(e => e.isFile()).map(e => `${dirName}/${e.name}`);
      if (files.length > 0) {
        result[dirName] = files;
        found = true;
      }
    } catch {
      // Directory doesn't exist or can't be read — skip
    }
  }

  return found ? result : undefined;
}

function buildMemoryPolicy(oma: Record<string, unknown>): MemoryPolicy {
  const raw = oma.memoryPolicy as Record<string, unknown> | undefined;
  if (!raw) {
    return {
      scopes: [{ type: 'session', readPolicy: 'always', writePolicy: 'always' }],
      captureEnabled: false,
      recallEnabled: false,
    };
  }

  const scopes = Array.isArray(raw.scopes) ? raw.scopes.map((s: any) => ({
    type: s.type as 'session' | 'user' | 'global',
    key: s.key as string | undefined,
    readPolicy: s.readPolicy as 'always' | 'on_demand' | 'never',
    writePolicy: s.writePolicy as 'always' | 'on_demand' | 'never',
  })) : [{ type: 'session' as const, readPolicy: 'always' as const, writePolicy: 'always' as const }];

  return {
    scopes: scopes.length > 0 ? scopes : [{ type: 'session', readPolicy: 'always', writePolicy: 'always' }],
    captureEnabled: typeof raw.captureEnabled === 'boolean' ? raw.captureEnabled : false,
    recallEnabled: typeof raw.recallEnabled === 'boolean' ? raw.recallEnabled : false,
  };
}

/**
 * Convert a name to kebab-case. For names without latin characters (e.g. CJK),
 * generates a deterministic short hash so the same name always produces the
 * same slug — essential for skill_create → reload consistency.
 */
function toKebabCase(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (slug) return slug;
  // Deterministic fallback: short hash of the name, prefixed for readability
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `sk-${hash}`;
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Load a single skill from a directory containing SKILL.md.
 */
export async function loadSkill(skillDirPath: string): Promise<LoadedSkill> {
  const absolutePath = resolve(skillDirPath);

  const rawContent = await readFile(join(absolutePath, PROMPT_FILE), 'utf-8');

  const parsed = parseFrontmatter(rawContent);
  if (!parsed) {
    throw new Error(`SKILL.md at ${absolutePath} has no valid YAML frontmatter (must start with "---")`);
  }

  const fm = FrontmatterSchema.parse(parsed.attrs);
  const meta = fm.metadata ?? {};

  // Build manifest
  // Use directory basename as the skill ID — the directory is the source of
  // truth (named by skill-creator or manual creation). Deriving from fm.name
  // via toKebabCase is lossy for CJK and produces IDs that don't match the
  // directory, breaking $skill-id and /skill-id explicit activation.
  const id = basename(absolutePath);
  const version = typeof meta.version === 'string' && /^\d+\.\d+\.\d+$/.test(meta.version)
    ? meta.version : '1.0.0';
  const author = typeof meta.author === 'string' ? meta.author : undefined;
  const tags = Array.isArray(meta.tags)
    ? meta.tags.map(String)
    : typeof meta.tags === 'string'
      ? meta.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean)
      : undefined;
  const priority = typeof meta.priority === 'number' ? meta.priority : 0;
  const triggers = generateTriggers(fm.name, meta);

  const manifest: Manifest = {
    id, name: fm.name, description: fm.description,
    version, triggers, priority, enabled: true,
    author, tags,
  };

  // Build tools (with optional OhMyAgent extensions)
  // Supports both string ("tool1 tool2") and YAML list (["tool1", "tool2"]) formats
  const rawAllowed = fm['allowed-tools'];
  const allowedTools = Array.isArray(rawAllowed)
    ? rawAllowed
    : typeof rawAllowed === 'string'
      ? rawAllowed.split(/\s+/).filter(Boolean)
      : [];
  const oma = (meta['x-ohmyagent'] as Record<string, unknown> | undefined) ?? {};
  const deniedTools = Array.isArray(oma.deniedTools)
    ? oma.deniedTools.map(String)
    : [];
  const tools: ToolsConfig = {
    allowedTools,
    ...(deniedTools.length > 0 ? { deniedTools } : {}),
  };

  // Build memory policy (from x-ohmyagent extension, or defaults)
  const memoryPolicy: MemoryPolicy = buildMemoryPolicy(oma);

  // Build approval overrides (from x-ohmyagent extension)
  const approvalOverrides = Array.isArray(oma.approvalOverrides)
    ? (oma.approvalOverrides as ApprovalOverride[])
    : undefined;

  // Build tools profile override (from x-ohmyagent extension)
  const toolsProfile = typeof oma.toolsProfile === 'string'
    ? oma.toolsProfile as ToolProfileId
    : undefined;

  // L3: Scan resource directories
  const resources = await scanResources(absolutePath);

  return {
    manifest,
    promptContent: parsed.body.trim(),
    tools,
    memoryPolicy,
    approvalOverrides,
    toolsProfile,
    path: absolutePath,
    ...(resources ? { resources } : {}),
  };
}

/**
 * Scan a directory for skill subdirectories, load and validate each one.
 * Invalid or incomplete skills are skipped with a warning (never throws).
 */
export async function loadAllSkills(
  skillsDirPath: string,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): Promise<LoadedSkill[]> {
  const absolutePath = resolve(skillsDirPath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'));

  const results: LoadedSkill[] = [];

  for (const dir of skillDirs) {
    try {
      const skill = await loadSkill(join(absolutePath, dir.name));
      results.push(skill);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        (logger?.warn ?? console.warn)(`[skill-loader] Skipping skill "${dir.name}": ${message}`);
      } catch {
        console.warn(`[skill-loader] Skipping skill "${dir.name}": ${message}`);
      }
    }
  }

  return results;
}
