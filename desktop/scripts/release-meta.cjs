// release-meta.cjs — generate the electron-builder-format latest.yml consumed
// by the sidecar updater (desktop/sidecar/src/updater.ts parseLatestYml).
//
// Usage: node scripts/release-meta.cjs <file...> <version> [name]
//   reads each installer, computes sha512 (base64), writes <name> (default
//   latest.yml) next to the FIRST file. The updater downloads <release>/<file>
//   and verifies against its sha512. Per-platform file names follow the
//   electron-builder convention: latest.yml (Windows), latest-mac.yml
//   (macOS), latest-linux.yml (Linux).
//
//   Multiple files: the `files:` array gets one entry per installer — the
//   macOS updater picks the entry matching its own architecture (see
//   selectUpdateFile in updater.ts). Legacy single-file calls still work.

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

function main() {
  const args = process.argv.slice(2);
  // Trailing [name] is the only optional arg; detect it by extension.
  const name = args.length > 2 && args[args.length - 1].endsWith('.yml') ? args.pop() : 'latest.yml';
  const version = args.pop();
  const installerPaths = args;
  if (!installerPaths.length || !version) {
    console.error('usage: node scripts/release-meta.cjs <installer-file> [more-files...] <version> [name]');
    process.exit(1);
  }
  const absList = installerPaths.map((p) => path.resolve(p));
  for (const abs of absList) {
    if (!fs.existsSync(abs)) {
      console.error(`release-meta: file not found: ${abs}`);
      process.exit(1);
    }
  }
  const releaseDate = new Date().toISOString();

  const fileEntries = absList.map((abs) => {
    const buf = fs.readFileSync(abs);
    return {
      fileName: path.basename(abs),
      sha512: createHash('sha512').update(buf).digest('base64'),
      size: buf.length,
    };
  });
  const [first] = fileEntries;

  const yml = [
    `version: ${version}`,
    `files:`,
    ...fileEntries.map(
      (f) => `  - url: ${f.fileName}\n    sha512: ${f.sha512}\n    size: ${f.size}`,
    ),
    `path: ${first.fileName}`,
    `sha512: ${first.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');

  const outPath = path.join(path.dirname(absList[0]), name);
  fs.writeFileSync(outPath, yml);
  console.log(`release-meta: wrote ${outPath}`);
  for (const f of fileEntries) {
    console.log(`release-meta:   ${f.fileName} sha512=${f.sha512.slice(0, 24)}... size=${f.size}`);
  }
}

main();
