// copy-pages.cjs — copy the shell's static pages (splash.html / error.html)
// into ui/dist so they land in tauri's EMBEDDED assets.
//
// Why: WebviewUrl::App("pages/…") loads tauri://localhost/…, and in production
// that protocol serves the frontendDist bundle embedded into the binary at
// build time (tauri's asset resolver) — it does NOT serve bundle.resources
// (those land in Resources/ as plain files). A page declared only in
// bundle.resources 404s on the protocol → the window shows a white (error) or
// transparent (splash) frame. Copying into ui/dist/pages/ makes the assets
// part of the embedded bundle on every build.
//
// The step is idempotent and cheap; it runs from the tauri build/dev commands
// (cwd = desktop/), which happen after `pnpm build:ui` in every pipeline.

const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const SRC = path.join(DESKTOP, 'src-tauri', 'pages');
const OUT = path.join(DESKTOP, '..', 'ui', 'dist', 'pages');

if (!fs.existsSync(SRC)) {
  console.error(`[copy-pages] source missing: ${SRC}`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  console.log(`[copy-pages] ${f} → ui/dist/pages/`);
}
