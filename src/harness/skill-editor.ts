// ---------------------------------------------------------------------------
// Self-Harness System — SkillEditor: applies approved improvement proposals
// to skill / config files on disk and commits the result to git.
// ---------------------------------------------------------------------------
// Security model: the proposal's diff.surface must be a *registered surface
// id* (the allow-list maintained by EditableSurfaceProvider). The resolver
// maps that id to the real file path — an LLM-provided proposal can never
// name an arbitrary path, and paths are never interpolated into shell
// commands (git runs via execFile with argument arrays).
// ---------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { ImprovementProposal, ApplyResult, ValidationResult } from './types.js';
import pino from 'pino';

const logger = pino();

/** Resolve a registered surface id to the file path it governs. */
export type SurfacePathResolver = (surfaceId: string) => string | undefined;

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.toString());
      },
    );
  });
}

export class SkillEditor {
  private readonly resolvePath: SurfacePathResolver;

  constructor(resolvePath: SurfacePathResolver) {
    this.resolvePath = resolvePath;
  }

  /**
   * Validates a proposal's diff fields without touching the filesystem.
   * - surface must resolve to a registered, safe file path
   * - before and after must be non-empty strings and differ from each other
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

    // The surface must be a *registered id*, not an arbitrary path — this is
    // the allow-list that prevents the harness from modifying anything other
    // than the surfaces it was given at startup.
    if (typeof proposal.diff.surface !== 'string' || proposal.diff.surface.length === 0) {
      errors.push('diff.surface must be a non-empty surface id');
    } else if (!this.resolvePath(proposal.diff.surface)) {
      errors.push(`diff.surface "${proposal.diff.surface}" is not a registered editable surface`);
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
   *  1. Validate the proposal (surface must be a registered id).
   *  2. Resolve the surface id to its file path.
   *  3. Read the target file and verify diff.before appears in it.
   *  4. Write the updated content.
   *  5. Stage and commit via git (execFile — no shell interpolation).
   *  6. On git failure, restore the original content so the file never
   *     diverges from what was committed.
   */
  async apply(proposal: ImprovementProposal): Promise<ApplyResult> {
    // 1. Validate
    const validation = this.validate(proposal);
    if (!validation.valid) {
      return {
        success: false,
        error: `validation failed: ${validation.errors.join('; ')}`,
      };
    }

    // 2. Resolve surface id → file path
    const surfacePath = this.resolvePath(proposal.diff.surface);
    if (!surfacePath) {
      return { success: false, error: `unregistered surface: ${proposal.diff.surface}` };
    }

    // 3. Read file content
    let content: string;
    try {
      content = await readFile(surfacePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `failed to read ${surfacePath}: ${message}` };
    }

    // 4. Replace before with after. Count occurrences first: a before text
    // that appears multiple times is only applied at the first site — the
    // caller gets a warning instead of a silently partial application.
    const occurrences = content.split(proposal.diff.before).length - 1;
    if (occurrences === 0) {
      return { success: false, error: 'diff before text not found in file' };
    }
    const updatedContent = content.replace(proposal.diff.before, proposal.diff.after);

    // 5. Write updated content, keeping the original for rollback
    try {
      await writeFile(surfacePath, updatedContent, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `failed to write ${surfacePath}: ${message}` };
    }

    // 6. Git operations (argument arrays — no shell injection)
    try {
      await execFileAsync('git', ['add', surfacePath]);
      await execFileAsync('git', ['commit', '-m', `harness: ${proposal.title}`.slice(0, 200)]);
    } catch (gitError) {
      // Restore the original content so the working tree matches the
      // repository state (atomicity).
      try {
        await writeFile(surfacePath, content, 'utf-8');
      } catch (restoreError) {
        logger.error(
          { restoreError, surfacePath },
          '[SkillEditor] git failed AND file restore failed — manual intervention required',
        );
      }
      const message = gitError instanceof Error ? gitError.message : String(gitError);
      return { success: false, error: `git operation failed (file restored): ${message}` };
    }

    // 7. Capture commit hash
    let commitHash: string;
    try {
      commitHash = (await execFileAsync('git', ['rev-parse', 'HEAD'])).trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `failed to retrieve commit hash: ${message}` };
    }

    const result: ApplyResult = { success: true, commitHash };
    if (occurrences > 1) {
      result.warning =
        `diff.before appeared ${occurrences} times; only the first occurrence was replaced`;
    }
    return result;
  }
}
