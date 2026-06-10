import { loadAllSkills, type LoadedSkill } from './skill-loader.js';
import { resolveSkillContext, type ResolvedSkill } from './skill-router.js';
import { compileSkillContext, type CompiledSkillContext } from './skill-compiler.js';

/**
 * Central registry that combines SkillLoader + SkillRouter + SkillCompiler.
 *
 * Usage:
 *   const registry = new SkillRegistry();
 *   await registry.load('./skills');
 *   const resolved = registry.resolve('help me take a screenshot with adb');
 *   const context = registry.compile(resolved);
 */
export class SkillRegistry {
  private skills: LoadedSkill[] = [];
  private loaded = false;

  /**
   * Load all skills from the given directory.
   * Can be called multiple times to reload.
   */
  async load(skillsDirPath: string, logger?: { warn: (msg: string, ...args: unknown[]) => void }): Promise<void> {
    this.skills = await loadAllSkills(skillsDirPath, logger);
    this.loaded = true;
  }

  /**
   * Resolve which skill(s) match the given user message.
   * Results are sorted by priority (highest first).
   * Returns empty array when skills are not yet loaded.
   */
  resolve(message: string): ResolvedSkill[] {
    if (!this.loaded) return [];
    return resolveSkillContext(message, this.skills);
  }

  /**
   * Compile resolved skills into a single merged context.
   */
  compile(resolved: ResolvedSkill[]): CompiledSkillContext {
    return compileSkillContext(resolved);
  }

  /**
   * Get all loaded skills. Returns empty array when not yet loaded.
   */
  getSkills(): LoadedSkill[] {
    if (!this.loaded) return [];
    return [...this.skills];
  }

  /**
   * Get a specific skill by its ID.
   */
  getSkillById(id: string): LoadedSkill | undefined {
    if (!this.loaded) return undefined;
    return this.skills.find((s) => s.manifest.id === id);
  }

  /**
   * Whether skills have been loaded at least once.
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}
