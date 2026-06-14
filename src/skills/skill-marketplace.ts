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
const SKILLS_SH_V1 = 'https://skills.sh/api/v1';
const SKILLS_DIR = resolve('./skills');

/** Vercel OIDC token for authenticated v1 API access. Set via SKILLS_SH_TOKEN env var. */
const SKILLS_SH_TOKEN = process.env.SKILLS_SH_TOKEN || '';

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

// ── Skills.sh v1 API types (authenticated) ───────────────────────────────────

interface SkillsShV1Skill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType?: string;
  installUrl?: string;
  url?: string;
}

interface SkillsShV1Response {
  data: SkillsShV1Skill[];
  pagination?: { page: number; per_page: number; total: number };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function mapV1Skill(s: SkillsShV1Skill): MarketplaceSkill {
  return {
    id: s.id,
    name: s.name || s.slug,
    description: '',
    package: s.id,
    source: 'skills.sh' as const,
    installs: s.installs ?? 0,
    url: s.url ?? `https://skills.sh/${s.id}`,
    author: s.source,
  };
}

// ── Skillhub CLI response types ───────────────────────────────────────────────

interface SkillhubCliItem {
  namespace?: string;
  slug?: string;
  latestVersion?: string;
  summary?: string;
}

interface SkillhubCliResponse {
  ok?: boolean;
  items?: SkillhubCliItem[];
  total?: number;
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
   * Search skillhub.cn via the @astron-team/skillhub CLI.
   * Falls back gracefully if the CLI is not installed or times out.
   *
   * NOTE: first run downloads the CLI package via npx, which can take 30-60s.
   * The CLI response uses `items` (not `skills`) with `slug`/`summary` fields.
   */
  async searchSkillhub(query: string, limit: number = 20): Promise<MarketplaceSkill[]> {
    try {
      const { stdout } = await execAsync(
        `npx --yes @astron-team/skillhub search "${query}" --json 2>/dev/null`,
        { timeout: 90_000, maxBuffer: 1024 * 1024 },
      );

      const trimmed = stdout.trim();
      if (!trimmed) return [];

      const data: SkillhubCliResponse = JSON.parse(trimmed);
      const items = data.items ?? [];

      return items.slice(0, limit).map((s) => {
        const slug = s.slug ?? '';
        const ns = s.namespace ?? 'global';
        const id = `${ns}/${slug}`;
        return {
          id,
          name: slug,
          description: s.summary ?? '',
          package: id,
          source: 'skillhub' as const,
          installs: 0,
          url: `https://skillhub.cn/skill/${ns}/${slug}`,
          version: s.latestVersion,
          author: ns !== 'global' ? ns : undefined,
        };
      });
    } catch {
      // CLI not available, timed out, or network error — return empty gracefully
      return [];
    }
  }

  /**
   * Unified search — queries selected marketplaces.
   *
   * Searches run sequentially to avoid overwhelming slow CLI startups,
   * but individual source failures never block the other source.
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
      // The package format is typically "owner/repo@skillname" or "namespace/slug"
      const skillName = packageName.split('@').pop() || packageName.split('/').pop() || packageName;
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
   * Fetch trending skills from the official skills.sh v1 API.
   * Requires a Vercel OIDC token (SKILLS_SH_TOKEN env var).
   * Falls back to bigram sampling on the old unauthenticated /api/search.
   */
  async getPopular(source: 'skills.sh' | 'skillhub' | 'all' = 'all', limit: number = 20): Promise<MarketplaceSkill[]> {
    const effectiveSource = source === 'all' ? 'skills.sh' : source;

    if (effectiveSource === 'skillhub') {
      const result = await this.search('agent', 'skillhub', limit);
      return result.results;
    }

    // 1. Try the authenticated v1 API first (real trending data)
    if (SKILLS_SH_TOKEN) {
      try {
        const skills = await this.getV1Trending(limit);
        if (skills.length > 0) return skills;
      } catch {
        // Fall through to bigram fallback
      }
    }

    // 2. Fallback: bigram sampling on the old unauthenticated /api/search
    return this.getPopularFallback(limit);
  }

  /**
   * Fetch trending skills from the skills.sh v1 API (authenticated).
   * GET /api/v1/skills?view=trending
   */
  private async getV1Trending(limit: number): Promise<MarketplaceSkill[]> {
    const url = `${SKILLS_SH_V1}/skills?view=trending&per_page=${Math.min(limit, 100)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${SKILLS_SH_TOKEN}` },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Token invalid/expired — don't retry, fall through to fallback
          return [];
        }
        throw new Error(`skills.sh v1 API returned ${res.status}`);
      }

      const data: SkillsShV1Response = await res.json();
      return (data.data ?? []).map(mapV1Skill);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('skills.sh v1 trending timed out');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Approximate trending via bigram sampling on the old unauthenticated API.
   *
   * The top 24 most frequent English bigrams are used as unbiased probes
   * across the entire skills.sh corpus. Results are merged, deduplicated,
   * and sorted by install count.
   */
  private async getPopularFallback(limit: number): Promise<MarketplaceSkill[]> {
    const bigrams = [
      'th', 'he', 'in', 'er', 'an', 're', 'on', 'at',
      'en', 'nd', 'ti', 'es', 'or', 'te', 'al', 'it',
      'is', 'ng', 'ar', 'st', 'ed', 'to', 'nt', 'ha',
    ];

    const searches = bigrams.map((bg) =>
      this.searchSkillsSh(bg, 15).catch(() => [] as MarketplaceSkill[]),
    );

    const allResults = await Promise.all(searches);
    const seen = new Set<string>();
    const merged: MarketplaceSkill[] = [];

    for (const batch of allResults) {
      for (const skill of batch) {
        if (seen.has(skill.id)) continue;
        seen.add(skill.id);
        merged.push(skill);
      }
    }

    merged.sort((a, b) => b.installs - a.installs);
    return merged.slice(0, limit);
  }
}
