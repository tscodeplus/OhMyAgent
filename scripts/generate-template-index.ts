/**
 * generate-template-index.ts
 *
 * Walks data/templates/agency-agents/ and data/templates/agency-agents-zh/,
 * parses YAML frontmatter from each .md file, and writes
 * data/templates/index.json.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

const TEMPLATES_DIR = resolve('./templates');

interface TemplateEntry {
  id: string;
  source: 'en' | 'zh';
  name: string;
  description: string;
  division: string;
  filePath: string;
  emoji?: string;
  color?: string;
}

interface TemplateIndex {
  version: number;
  updated: string;
  templates: TemplateEntry[];
}

/** Extract frontmatter attributes and body from raw markdown content */
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

  // Strip null values (YAML maps empty to null, but we want undefined)
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null) {
      attrs[key] = value;
    }
  }

  return { attrs, body };
}

/** Derive a stable slug from a file path (e.g. "engineering/engineering-frontend-developer.md" → "engineering-frontend-developer") */
function pathToSlug(sourceDir: string, filePath: string): string {
  return filePath
    .replace(/\.md$/i, '')
    .replace(/\//g, '-');
}

async function scanDirectory(
  sourceDir: string,
  source: 'en' | 'zh',
): Promise<TemplateEntry[]> {
  const templates: TemplateEntry[] = [];
  const absSourceDir = resolve(join(TEMPLATES_DIR, sourceDir));

  let divisionDirs: string[];
  try {
    const entries = await readdir(absSourceDir, { withFileTypes: true });
    divisionDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    console.warn(`[generate-index] Directory not found: ${absSourceDir}`);
    return templates;
  }

  for (const division of divisionDirs) {
    const divisionPath = join(absSourceDir, division);
    let files: string[];
    try {
      files = await readdir(divisionPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = join(divisionPath, file);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) continue;

      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        console.warn(`[generate-index] Cannot read: ${filePath}`);
        continue;
      }

      // Strip BOM if present
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }

      const parsed = parseFrontmatter(content);
      if (!parsed) {
        console.warn(`[generate-index] No valid frontmatter in: ${filePath}`);
        continue;
      }

      const name = typeof parsed.attrs.name === 'string' ? parsed.attrs.name : file.replace(/\.md$/i, '').replace(/-/g, ' ');
      const description = typeof parsed.attrs.description === 'string' ? parsed.attrs.description : '';
      const emoji = typeof parsed.attrs.emoji === 'string' ? parsed.attrs.emoji : undefined;
      const color = typeof parsed.attrs.color === 'string' ? parsed.attrs.color : undefined;

      const relPath = relative(absSourceDir, filePath);
      const id = `${source}-${pathToSlug(sourceDir, relPath)}`;

      templates.push({
        id,
        source,
        name,
        description,
        division,
        filePath: relPath,
        ...(emoji ? { emoji } : {}),
        ...(color ? { color } : {}),
      });
    }
  }

  return templates;
}

async function main() {
  console.log('[generate-index] Scanning templates...');

  const enTemplates = await scanDirectory('agency-agents', 'en');
  console.log(`[generate-index] Found ${enTemplates.length} English templates`);

  const zhTemplates = await scanDirectory('agency-agents-zh', 'zh');
  console.log(`[generate-index] Found ${zhTemplates.length} Chinese templates`);

  const index: TemplateIndex = {
    version: 1,
    updated: new Date().toISOString(),
    templates: [...enTemplates, ...zhTemplates],
  };

  const indexPath = join(TEMPLATES_DIR, 'index.json');
  await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`[generate-index] Written ${index.templates.length} templates to ${indexPath}`);
}

main().catch((err) => {
  console.error('[generate-index] Fatal error:', err);
  process.exit(1);
});
