/**
 * Skill Marketplace Service
 *
 * Provides search and install capabilities from skills.sh and skillhub.cn.
 * After installation, reloads the SkillRegistry so new skills are immediately available.
 *
 * Popular skills are fetched directly from:
 *   - skills.sh homepage (top 10 by all-time installs)
 *   - skillhub.cn API (top 10 by download count)
 */

import { resolve, join, basename } from 'node:path';
import { mkdir, writeFile, readdir, cp, rm } from 'node:fs/promises';
import { runNpx } from './npx-runner.js';
import AdmZip from 'adm-zip';

const SKILLS_SH_API = 'https://skills.sh/api';
const SKILLS_SH_HOME = 'https://www.skills.sh';
const SKILLHUB_API = 'https://api.skillhub.cn/api';
const SKILLS_DIR = resolve('./skills');

// ── Types ────────────────────────────────────────────────────────────────────

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  package: string;
  source: 'skills.sh' | 'skillhub';
  installs: number;
  url: string;
  author?: string;
  version?: string;
}

export interface MarketplaceSearchResult {
  query: string;
  source: string;
  results: MarketplaceSkill[];
}

export interface InstallResult {
  success: boolean;
  skillId?: string;
  skillName?: string;
  error?: string;
}

// ── Skills.sh API response types ─────────────────────────────────────────────

interface SkillsShApiSkill {
  id?: string;
  skillId?: string;
  name?: string;
  description?: string;
  installs?: number;
  source?: string;
}

interface SkillsShApiResponse {
  skills?: SkillsShApiSkill[];
}

// ── Skillhub.cn API types ────────────────────────────────────────────────────

interface SkillhubApiSkill {
  slug: string;
  name: string;
  description: string;
  downloads: number;
  installs: number;
  ownerName: string;
  homepage: string;
  version?: string;
  source?: string;
  category?: string;
  tags?: string[] | null;
}

interface SkillhubApiResponse {
  code: number;
  data: {
    skills: SkillhubApiSkill[];
    total?: number;
  };
}

// ── Marketplace class ────────────────────────────────────────────────────────

export class SkillMarketplace {
  constructor(
    private skillRegistry: { load: (dir: string) => Promise<void> },
  ) {}

  /**
   * Search skills.sh REST API.
   * The skills.sh API does fuzzy matching on skill name and tags.
   */
  async searchSkillsSh(query: string, limit: number = 20): Promise<MarketplaceSkill[]> {
    const url = `${SKILLS_SH_API}/search?q=${encodeURIComponent(query)}&limit=${limit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`skills.sh API returned ${res.status}`);
      }

      const data: SkillsShApiResponse = await res.json();
      const skills = data.skills ?? [];

      return skills.map((s) => ({
        id: s.id ?? s.skillId ?? '',
        name: s.name ?? s.skillId ?? s.id ?? '',
        description: s.description ?? '',
        package: s.id ?? '',
        source: 'skills.sh' as const,
        installs: s.installs ?? 0,
        url: s.id ? `https://skills.sh/${s.id}` : 'https://skills.sh',
        author: s.source,
      }));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('skills.sh search timed out');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Search skillhub.cn via its public API.
   * GET https://api.skillhub.cn/api/skills?keyword=<query>&pageSize=<limit>
   */
  async searchSkillhub(query: string, limit: number = 20): Promise<MarketplaceSkill[]> {
    const url = `${SKILLHUB_API}/skills?keyword=${encodeURIComponent(query)}&page=1&pageSize=${limit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`skillhub.cn API returned ${res.status}`);

      const data: SkillhubApiResponse = await res.json();
      if (data.code !== 0) throw new Error(`skillhub.cn API error: code=${data.code}`);

      return (data.data.skills ?? []).map((s) => ({
        id: `${s.ownerName}/${s.slug}`,
        name: s.name || s.slug,
        description: s.description ?? '',
        package: `${s.ownerName}/${s.slug}`,
        source: 'skillhub' as const,
        installs: s.downloads ?? s.installs ?? 0,
        url: `https://www.skillhub.cn/skills/${s.slug}`,
        author: s.ownerName,
        version: s.version,
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Unified search — queries selected marketplaces.
   */
  async search(
    query: string,
    source: 'skills.sh' | 'skillhub' | 'all' = 'all',
    limit: number = 20,
  ): Promise<MarketplaceSearchResult> {
    const results: MarketplaceSkill[] = [];

    if (source === 'all' || source === 'skills.sh') {
      try {
        const sh = await this.searchSkillsSh(query, limit);
        results.push(...sh);
      } catch {
        // skills.sh failed — continue with skillhub results
      }
    }

    if (source === 'all' || source === 'skillhub') {
      try {
        const hub = await this.searchSkillhub(query, limit);
        results.push(...hub);
      } catch {
        // skillhub failed — continue
      }
    }

    results.sort((a, b) => b.installs - a.installs);
    return { query, source, results: results.slice(0, limit) };
  }

  /**
   * Install a skill from the marketplace.
   */
  async install(packageName: string, source: 'skills.sh' | 'skillhub'): Promise<InstallResult> {
    if (source === 'skillhub') {
      return this.installFromSkillhub(packageName);
    }
    return this.installFromSkillsSh(packageName);
  }

  /**
   * Install a skill from skillhub.cn by downloading the zip package.
   * GET https://api.skillhub.cn/api/v1/download?slug=<slug> returns a zip
   * containing SKILL.md and _meta.json. Extract into skills/<slug>/.
   */
  private async installFromSkillhub(packageName: string): Promise<InstallResult> {
    const slug = packageName.split('/').pop() || packageName;
    const downloadUrl = `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(slug)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(downloadUrl, { signal: controller.signal });
      if (!res.ok) {
        return { success: false, error: `skillhub.cn 下载失败 (HTTP ${res.status})` };
      }

      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength < 100) {
        const text = new TextDecoder().decode(arrayBuffer);
        return { success: false, error: `skillhub.cn 下载失败: ${text.trim() || 'empty response'}` };
      }

      // Extract zip into skills/<slug>/
      const skillDir = join(SKILLS_DIR, slug);
      const zip = new AdmZip(Buffer.from(arrayBuffer));
      await mkdir(skillDir, { recursive: true });

      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const filePath = join(skillDir, entry.entryName);
        await mkdir(filePath.replace(/[/\\][^/\\]*$/, ''), { recursive: true });
        await writeFile(filePath, entry.getData());
      }

      await this.skillRegistry.load(SKILLS_DIR);

      return { success: true, skillId: slug, skillName: slug };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Install a skill from skills.sh via npx skills add.
   * Package format: "owner/repo/skill-name" → "owner/repo@skill-name"
   */
  private async installFromSkillsSh(packageName: string): Promise<InstallResult> {
    const lastSlash = packageName.lastIndexOf('/');
    const pkg = lastSlash > 0
      ? `${packageName.slice(0, lastSlash)}@${packageName.slice(lastSlash + 1)}`
      : packageName;

    try {
      const { stdout, stderr } = await runNpx(
        ['--yes', 'skills', 'add', pkg, '-y', '--agent', 'pi'],
        {
          timeout: 120_000,
          cwd: SKILLS_DIR,
          env: { ...process.env, FORCE_COLOR: '0' },
        },
      );

      const output = stdout + stderr;

      const success =
        output.includes('Installation complete') ||
        output.includes('Installed') ||
        output.includes('successfully') ||
        output.includes('added');

      if (!success) {
        return { success: false, error: output.slice(-500) || 'Unknown installation error' };
      }

      // npx skills add installs to .pi/skills/<name>/ — move to skills/<name>/
      const skillName = pkg.split('@').pop() || packageName;
      const skillId = skillName.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      const piSkillsDir = join(SKILLS_DIR, '.pi', 'skills');
      const targetDir = join(SKILLS_DIR, skillId);

      try {
        const entries = await readdir(piSkillsDir);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const src = join(piSkillsDir, entry);
          // Move to skills/<id>/, overwriting any previous version
          await rm(targetDir, { recursive: true, force: true });
          await cp(src, targetDir, { recursive: true });
          await rm(src, { recursive: true, force: true });
          break; // Only move the first (most recently installed) skill
        }
      } catch {
        // If .pi/skills doesn't exist or is empty, the skill may already be
        // in the right place — proceed with reload anyway.
      }

      await this.skillRegistry.load(SKILLS_DIR);

      return { success: true, skillId, skillName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  // ── Popular skills ──────────────────────────────────────────────────────────

  /**
   * Get popular skills from both marketplaces.
   *
   * - skills.sh: scrapes the homepage leaderboard (all-time ranking), then
   *   enriches each skill with its install count via the search API.
   * - skillhub.cn: calls the API sorted by downloads.
   *
   * Results are returned separately per source (no cross-source dedup).
   */
  async getPopular(
    source: 'skills.sh' | 'skillhub' | 'all' = 'all',
    limit: number = 20,
  ): Promise<MarketplaceSkill[]> {
    const results: MarketplaceSkill[] = [];

    if (source === 'all' || source === 'skills.sh') {
      try {
        const count = source === 'all' ? 10 : limit;
        const ids = await this.fetchSkillsShHomepageIds(count);
        const sh = await this.enrichSkillsShWithInstalls(ids);
        results.push(...sh);
      } catch {
        // skills.sh homepage scrape failed — continue
      }
    }

    if (source === 'all' || source === 'skillhub') {
      try {
        const count = source === 'all' ? 10 : limit;
        const hub = await this.fetchSkillhubDownloadRanking(count);
        results.push(...hub);
      } catch {
        // skillhub API failed — continue
      }
    }

    return results;
  }

  /**
   * Scrape skills.sh homepage for top N skill IDs (in leaderboard order).
   */
  private async fetchSkillsShHomepageIds(limit: number): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(SKILLS_SH_HOME, { signal: controller.signal });
      if (!res.ok) throw new Error(`skills.sh homepage returned ${res.status}`);

      const html = await res.text();
      return this.parseSkillsShIds(html, limit);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Extract skill IDs from skills.sh homepage HTML. */
  private parseSkillsShIds(html: string, limit: number): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    const rowRegex = /href="(\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = rowRegex.exec(html)) !== null) {
      const id = match[1].slice(1); // strip leading /
      const parts = id.split('/');
      if (parts.length !== 3) continue;

      const [owner] = parts as [string, string, string];
      const skip = new Set(['topic', 'trending', 'hot', 'official', 'search', 'docs',
        'about', 'audit', 'contact', 'privacy', 'terms', 'agent', 'agents', 'api',
        'icon', 'favicon', 'svg', 'opengraph', 'sitemap']);
      if (skip.has(owner)) continue;

      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);

      if (ids.length >= limit) break;
    }

    return ids;
  }

  /**
   * Enrich skills.sh skill IDs with install counts via parallel search API lookups.
   */
  private async enrichSkillsShWithInstalls(ids: string[]): Promise<MarketplaceSkill[]> {
    // Search each skill by name (the last segment of the ID) to get its install count
    const lookups = ids.map(async (id) => {
      const name = id.split('/').pop() || id;
      const [owner, repo] = id.split('/');
      try {
        const skills = await this.searchSkillsSh(name, 5);
        const match = skills.find((s) => s.id === id);
        if (match) return match;
        // Fallback: build minimal skill without install count
        return {
          id,
          name,
          description: '',
          package: id,
          source: 'skills.sh' as const,
          installs: 0,
          url: `https://skills.sh/${id}`,
          author: `${owner}/${repo}`,
        };
      } catch {
        return {
          id,
          name,
          description: '',
          package: id,
          source: 'skills.sh' as const,
          installs: 0,
          url: `https://skills.sh/${id}`,
          author: `${owner}/${repo}`,
        };
      }
    });

    return Promise.all(lookups);
  }

  /**
   * Fetch the download ranking from skillhub.cn API.
   * GET https://api.skillhub.cn/api/skills?sortBy=downloads&order=desc
   */
  private async fetchSkillhubDownloadRanking(limit: number): Promise<MarketplaceSkill[]> {
    const url = `${SKILLHUB_API}/skills?page=1&pageSize=${limit}&sortBy=downloads&order=desc`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`skillhub.cn API returned ${res.status}`);

      const data: SkillhubApiResponse = await res.json();
      if (data.code !== 0) throw new Error(`skillhub.cn API error: code=${data.code}`);

      return (data.data.skills ?? []).map((s) => ({
        id: `${s.ownerName}/${s.slug}`,
        name: s.name || s.slug,
        description: s.description ?? '',
        package: `${s.ownerName}/${s.slug}`,
        source: 'skillhub' as const,
        installs: s.downloads ?? s.installs ?? 0,
        url: `https://www.skillhub.cn/skills/${s.slug}`,
        author: s.ownerName,
        version: s.version,
      }));
    } finally {
      clearTimeout(timer);
    }
  }
}
