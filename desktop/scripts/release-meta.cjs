// release-meta.cjs — generate the electron-builder-format latest.yml consumed
// by the sidecar updater (desktop/sidecar/src/updater.ts parseLatestYml).
//
// Usage: node scripts/release-meta.cjs <installer-file> <version>
//   reads the installer, computes sha512 (base64), writes latest.yml next to it.
//   The updater downloads <release>/<file> and verifies against this sha512.

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

function main() {
  const [installerPath, version] = process.argv.slice(2);
  if (!installerPath || !version) {
    console.error('usage: node scripts/release-meta.cjs <installer-file> <version>');
    process.exit(1);
  }
  const abs = path.resolve(installerPath);
  if (!fs.existsSync(abs)) {
    console.error(`release-meta: file not found: ${abs}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(abs);
  const sha512 = createHash('sha512').update(buf).digest('base64');
  const fileName = path.basename(abs);
  const releaseDate = new Date().toISOString();

  const yml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${buf.length}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');

  const outPath = path.join(path.dirname(abs), 'latest.yml');
  fs.writeFileSync(outPath, yml);
  console.log(`release-meta: wrote ${outPath}`);
  console.log(`release-meta: version=${version} sha512=${sha512.slice(0, 24)}... size=${buf.length}`);
}

main();
