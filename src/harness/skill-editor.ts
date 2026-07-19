// ---------------------------------------------------------------------------
// Self-Harness System — SkillEditor: applies approved improvement proposals
// to skill / config files on disk and commits the result to git.
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ImprovementProposal, ApplyResult, ValidationResult } from './types.js';

export class SkillEditor {
  constructor() {
    // No dependencies for now.
  }

  /**
   * Validates a proposal's diff fields without touching the filesystem.
   * - before and after must be non-empty strings
   * - before and after must differ
   * - surface path must not contain ".." (path traversal guard)
   */
  validate(proposal: ImprovementProposal): ValidationResult {
    const errors: string[] = [];

    if (typeof proposal.diff.before !== 'string' || proposal.diff.before.length === 0) {
      errors.push('diff.before must be a non-empty string');
    }

    if (typeof proposal.diff.after !== 'string' || proposal.diff.after.length === 0) {
      errors.push('diff.after must be a non-empty string');
    }

    if (proposal.diff.before === proposal.diff.after) {
      errors.push('diff.before and diff.after must be different');
    }

    if (proposal.diff.surface.includes('..')) {
      errors.push('diff.surface path must not contain ".."');
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Applies an approved proposal to its target file and commits the change.
   *
   * Flow:
   *  1. Validate the proposal.
   *  2. Read the target file from disk.
   *  3. Replace diff.before with diff.after in the file contents.
   *  4. Write the updated content back.
   *  5. Stage, commit, and capture the commit hash via git.
   */
  async apply(proposal: ImprovementProposal): Promise<ApplyResult> {
    try {
      // 1. Validate
      const validation = this.validate(proposal);
      if (!validation.valid) {
        return {
          success: false,
          error: `validation failed: ${validation.errors.join('; ')}`,
        };
      }

      const surfacePath = proposal.diff.surface;

      // 2. Check file exists
      if (!existsSync(surfacePath)) {
        return {
          success: false,
          error: `file not found: ${surfacePath}`,
        };
      }

      // 3. Read file content
      const content = await readFile(surfacePath, 'utf-8');

      // 4. Replace before with after
      const updatedContent = content.replace(proposal.diff.before, proposal.diff.after);

      if (updatedContent === content) {
        return {
          success: false,
          error: 'diff before text not found in file',
        };
      }

      // 5. Write updated content
      await writeFile(surfacePath, updatedContent, 'utf-8');

      // 6. Git operations
      try {
        execSync(`git add ${surfacePath}`, { cwd: process.cwd() });
        execSync(`git commit -m "harness: ${proposal.title}"`, { cwd: process.cwd() });
      } catch (gitError) {
        const message = gitError instanceof Error ? gitError.message : String(gitError);
        return { success: false, error: `git operation failed: ${message}` };
      }

      let commitHash: string;
      try {
        commitHash = execSync('git rev-parse HEAD', {
          cwd: process.cwd(),
          encoding: 'utf-8',
        }).trim();
      } catch (gitError) {
        const message = gitError instanceof Error ? gitError.message : String(gitError);
        return { success: false, error: `failed to retrieve commit hash: ${message}` };
      }

      return { success: true, commitHash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
