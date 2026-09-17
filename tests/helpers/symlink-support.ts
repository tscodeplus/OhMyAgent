// Symlink support probe for the test suite.
//
// Creating a symlink needs a privilege on Windows (Developer Mode, or an
// elevated process); without it `fs.symlink*` fails with `EPERM`/`EACCES`.
// Symlink-escape tests therefore have to skip there instead of failing the
// whole suite on a locked-down Windows box. Under WSL and POSIX the probe
// succeeds and the tests run as before.

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const canCreateSymlinks: boolean = (() => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'oma-symlink-probe-'));
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
})();
