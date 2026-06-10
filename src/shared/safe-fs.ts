import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file without following a symlink at the final path component.
 *
 * PathAccessPolicy resolves and approves a path at check time, but there is a
 * TOCTOU gap before the actual write: an attacker who can create files in a
 * writable directory could plant a symlink at the target that points outside
 * the approved root. Opening with O_NOFOLLOW makes the kernel refuse to follow
 * such a symlink, closing that gap for the target component.
 *
 * Parent directories are created with recursive mkdir first (matching the
 * previous behavior). The final open is symlink-safe.
 */
export function writeFileNoFollow(
  resolvedPath: string,
  content: string | Buffer,
): number {
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });

  // O_NOFOLLOW: fail (ELOOP) if the final component is a symlink.
  // O_WRONLY|O_CREAT|O_TRUNC: standard "overwrite or create" write semantics.
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    fs.constants.O_NOFOLLOW;

  let fd: number | undefined;
  try {
    fd = fs.openSync(resolvedPath, flags, 0o644);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    fs.writeSync(fd, buf);
    return buf.length;
  } catch (err: any) {
    if (err?.code === 'ELOOP') {
      throw new Error(
        `Refusing to write through a symlink at ${resolvedPath} (possible path-escape attempt).`,
      );
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
