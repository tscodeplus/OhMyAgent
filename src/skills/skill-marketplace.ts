/**
 * Skill Marketplace Service
 *
 * Provides search and install capabilities from skills.sh and skillhub.cn.
 * After installation, reloads the SkillRegistry so new skills are immediately available.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execAsync = promisify(exec);

const SKILLS_SH_API = 'https://skills.sh/api';
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

// ── Marketplace class ────────────────────────────────────────────────────────

export class SkillMarketplace {
  constructor(
    private skillRegistry: { load: (dir: string) => Promise<void> },
  ) {}

  /**
   * Search skills.sh REST API.
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
   * Search skillhub.cn via the @astron-team/skillhub CLI.
   * Falls back gracefully if the CLI is not installed.
   */
  async searchSkillhub(query: string, limit: number = 20): Promise<MarketplaceSkill[]> {
    try {
      const { stdout } = await execAsync(
        `npx --yes @astron-team/skillhub search "${query}" --json 2>/dev/null`,
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );

      const trimmed = stdout.trim();
      if (!trimmed) return [];

      const data = JSON.parse(trimmed);
      const skills = Array.isArray(data) ? data : (data.skills ?? data.results ?? []);

      return skills.slice(0, limit).map((s: any) => ({
        id: s.id ?? s.name ?? '',
        name: s.name ?? s.id ?? '',
        description: s.description ?? '',
        package: s.package ?? s.id ?? s.name ?? '',
        source: 'skillhub' as const,
        installs: s.installs ?? s.downloads ?? 0,
        url: s.url ?? (s.package ? `https://skillhub.cn/skill/${s.package}` : 'https://skillhub.cn'),
        author: s.author ?? s.owner,
        version: s.version,
      }));
    } catch {
      // CLI not available or network error — return empty gracefully
      return [];
    }
  }

  /**
   * Unified search — queries both marketplaces in parallel.
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

    // Sort by installs descending
    results.sort((a, b) => b.installs - a.installs);

    return {
      query,
      source,
      results: results.slice(0, limit),
    };
  }

  /**
   * Install a skill from the marketplace.
   *
   * - skills.sh: uses `npx skills add <package> -y --agent pi`
   * - skillhub:  uses `npx @astron-team/skillhub install <package> --agent claude-code -y`
   *
   * After installation, reloads the SkillRegistry.
   */
  async install(packageName: string, source: 'skills.sh' | 'skillhub'): Promise<InstallResult> {
    let cmd: string;

    if (source === 'skillhub') {
      cmd = `npx --yes @astron-team/skillhub install "${packageName}" --agent claude-code -y`;
    } else {
      cmd = `npx --yes skills add "${packageName}" -y --agent pi`;
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        cwd: SKILLS_DIR,
      });

      const output = stdout + stderr;

      // Check for success indicators
      const success =
        output.includes('Installation complete') ||
        output.includes('Installed') ||
        output.includes('successfully') ||
        output.includes('added');

      if (!success) {
        return { success: false, error: output.slice(-500) || 'Unknown installation error' };
      }

      // Reload skills so the new skill is immediately available
      await this.skillRegistry.load(SKILLS_DIR);

      // Try to discover the installed skill's ID from its directory name
      // The package format is typically "owner/repo@skillname"
      const skillName = packageName.split('@').pop() || packageName;
      const skillId = skillName.toLowerCase().replace(/[^a-z0-9._-]/g, '-');

      return {
        success: true,
        skillId,
        skillName,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Get popular/trending skills from skills.sh.
   * Uses an empty search which returns top installed skills.
   */
  async getPopular(source: 'skills.sh' | 'skillhub' | 'all' = 'all', limit: number = 20): Promise<MarketplaceSkill[]> {
    const result = await this.search('', source, limit);
    return result.results;
  }
}
