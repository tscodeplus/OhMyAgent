import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PathAccessPolicyImpl } from '../../src/policy/path-policy';
import type { AgentPolicyScope } from '../../src/policy/types';

function scope(overrides: Partial<AgentPolicyScope> = {}): AgentPolicyScope {
  return {
    toolsProfile: 'standard',
    readRoots: [],
    writeRoots: [],
    deniedPatterns: [],
    shellExecMode: 'balanced',
    sessionApprovals: [],
    appApprovals: [],
    readOnly: false,
    computerUseEnabled: false,
    ...overrides,
  };
}

describe('PathAccessPolicyImpl', () => {
  it('does not allow sibling paths that merely share a root prefix', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'oma-policy-root-'));
    const sibling = `${base}-sibling`;
    await mkdir(sibling, { recursive: true });

    const policy = new PathAccessPolicyImpl({
      readRoots: [base],
      writeRoots: [],
      deniedPatterns: [],
      autoInjectCwd: false,
    });

    const decision = policy.check({
      path: path.join(sibling, 'secret.txt'),
      operation: 'read',
      scope: scope(),
    });

    expect(decision.allowed).toBe(false);
    await rm(base, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  });

  it('supports double-star deny patterns and preserves legacy nested matching', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'oma-policy-glob-'));
    const a = path.join(base, 'a');
    const deep = path.join(a, 'b', 'c');
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'id_rsa'), 'secret');
    await writeFile(path.join(a, 'note.txt'), 'ok');

    // Double-star crosses segments explicitly; single-star legacy patterns
    // must still match nested paths (deny fails safe by widening).
    const starSsh = ['*', '*', 'id_rsa'].join('/'); // legacy multi-segment
    const doubleStar = ['**', 'id_rsa'].join('/');   // explicit cross-segment

    for (const pattern of [doubleStar, starSsh]) {
      const policy = new PathAccessPolicyImpl({
        readRoots: [base],
        writeRoots: [],
        deniedPatterns: [pattern],
        autoInjectCwd: false,
      });
      expect(
        policy.check({ path: path.join(deep, 'id_rsa'), operation: 'read', scope: scope() }).allowed,
      ).toBe(false);
      // A non-matching sibling under the root stays allowed.
      expect(
        policy.check({ path: path.join(a, 'note.txt'), operation: 'read', scope: scope() }).allowed,
      ).toBe(true);
    }

    await rm(base, { recursive: true, force: true });
  });

  it('preserves denied glob semantics for basenames and nested paths', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'oma-policy-deny-'));
    const sshDir = path.join(base, '.ssh');
    await mkdir(sshDir);
    await writeFile(path.join(base, '.env'), 'secret');
    await writeFile(path.join(base, 'key.pem'), 'secret');
    await writeFile(path.join(sshDir, 'id_rsa'), 'secret');

    const policy = new PathAccessPolicyImpl({
      readRoots: [base],
      writeRoots: [],
      deniedPatterns: ['.env', '*.pem', '*/.ssh/*'],
      autoInjectCwd: false,
    });

    for (const filePath of [
      path.join(base, '.env'),
      path.join(base, 'key.pem'),
      path.join(sshDir, 'id_rsa'),
    ]) {
      const decision = policy.check({
        path: filePath,
        operation: 'read',
        scope: scope(),
      });
      expect(decision.allowed).toBe(false);
    }

    await rm(base, { recursive: true, force: true });
  });

  it('uses scoped roots to narrow configured roots', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'oma-policy-scope-'));
    const allowed = path.join(base, 'allowed');
    const blocked = path.join(base, 'blocked');
    await mkdir(allowed);
    await mkdir(blocked);

    const policy = new PathAccessPolicyImpl({
      readRoots: [base],
      writeRoots: [],
      deniedPatterns: [],
      autoInjectCwd: false,
    });

    expect(policy.check({
      path: path.join(allowed, 'ok.txt'),
      operation: 'read',
      scope: scope({ readRoots: [allowed] }),
    }).allowed).toBe(true);

    expect(policy.check({
      path: path.join(blocked, 'no.txt'),
      operation: 'read',
      scope: scope({ readRoots: [allowed] }),
    }).allowed).toBe(false);

    await rm(base, { recursive: true, force: true });
  });

  it('can update roots and denied patterns after construction', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'oma-policy-update-'));
    const next = await mkdtemp(path.join(tmpdir(), 'oma-policy-update-next-'));
    await writeFile(path.join(next, 'ok.txt'), 'ok');
    await writeFile(path.join(next, 'secret.pem'), 'secret');

    const policy = new PathAccessPolicyImpl({
      readRoots: [base],
      writeRoots: [],
      deniedPatterns: [],
      autoInjectCwd: false,
    });

    policy.updateConfig({
      readRoots: [next],
      writeRoots: [],
      deniedPatterns: ['*.pem'],
      autoInjectCwd: false,
    });

    expect(policy.check({
      path: path.join(base, 'old.txt'),
      operation: 'read',
      scope: scope(),
    }).allowed).toBe(false);
    expect(policy.check({
      path: path.join(next, 'ok.txt'),
      operation: 'read',
      scope: scope(),
    }).allowed).toBe(true);
    expect(policy.check({
      path: path.join(next, 'secret.pem'),
      operation: 'read',
      scope: scope(),
    }).allowed).toBe(false);

    await rm(base, { recursive: true, force: true });
    await rm(next, { recursive: true, force: true });
  });

  it('canonicalizes write targets through existing symlink parents', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'oma-policy-write-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'oma-policy-write-outside-'));
    const link = path.join(base, 'link');

    try {
      await symlink(outside, link, 'dir');
    } catch (err) {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      throw err;
    }

    const policy = new PathAccessPolicyImpl({
      readRoots: [],
      writeRoots: [base],
      deniedPatterns: [],
      autoInjectCwd: false,
    });

    const decision = policy.check({
      path: path.join(link, 'created.txt'),
      operation: 'write',
      scope: scope(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.resolvedPath).toBe(path.join(outside, 'created.txt'));

    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});
