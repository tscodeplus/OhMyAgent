/**
 * File icon mapping — maps file extensions and known filenames to Lucide icons
 * with Tailwind color classes.
 *
 * Resolution order: exact filename → .env prefix → extension → fallback (File icon).
 */

import {
  Archive,
  Binary,
  Blocks,
  BookOpen,
  Box,
  Braces,
  Code2,
  Cog,
  Coffee,
  Cpu,
  Database,
  File,
  FileCheck,
  FileCode,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Flame,
  FlaskConical,
  Gem,
  Globe,
  Hash,
  Hexagon,
  Image,
  Lock,
  Music2,
  NotebookPen,
  Palette,
  Scroll,
  Settings,
  Shield,
  SquareFunction,
  Terminal,
  Video,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export interface FileIconData {
  icon: LucideIcon;
  color: string;
}

type IconMap = Record<string, FileIconData>;

const FILE_ICON_MAP: IconMap = {
  // ── Archives & binaries ──
  '7z': { icon: Archive, color: 'text-amber-500' },
  bin: { icon: Binary, color: 'text-neutral-500' },
  bz2: { icon: Archive, color: 'text-amber-600' },
  dll: { icon: Binary, color: 'text-neutral-400' },
  exe: { icon: Binary, color: 'text-neutral-500' },
  gz: { icon: Archive, color: 'text-amber-600' },
  lock: { icon: Lock, color: 'text-neutral-500' },
  rar: { icon: Archive, color: 'text-amber-500' },
  tar: { icon: Archive, color: 'text-amber-600' },
  wasm: { icon: Binary, color: 'text-purple-500' },
  zip: { icon: Archive, color: 'text-amber-600' },

  // ── Config / dotfiles ──
  cfg: { icon: Settings, color: 'text-neutral-500' },
  conf: { icon: Settings, color: 'text-neutral-500' },
  ini: { icon: Settings, color: 'text-neutral-500' },
  toml: { icon: Settings, color: 'text-neutral-500' },
  yaml: { icon: Settings, color: 'text-purple-400' },
  yml: { icon: Settings, color: 'text-purple-400' },

  // ── Data & serialization ──
  csv: { icon: FileSpreadsheet, color: 'text-green-600' },
  json: { icon: Braces, color: 'text-yellow-600' },
  json5: { icon: Braces, color: 'text-yellow-500' },
  jsonc: { icon: Braces, color: 'text-yellow-500' },
  tsv: { icon: FileSpreadsheet, color: 'text-green-500' },
  xml: { icon: FileCode, color: 'text-orange-500' },

  // ── Documents & text ──
  doc: { icon: FileText, color: 'text-blue-600' },
  docx: { icon: FileText, color: 'text-blue-600' },
  log: { icon: Scroll, color: 'text-neutral-400' },
  map: { icon: File, color: 'text-neutral-400' },
  md: { icon: BookOpen, color: 'text-blue-500' },
  mdx: { icon: BookOpen, color: 'text-blue-400' },
  pdf: { icon: FileCheck, color: 'text-red-600' },
  rst: { icon: FileText, color: 'text-neutral-400' },
  rtf: { icon: FileText, color: 'text-neutral-500' },
  tex: { icon: Scroll, color: 'text-teal-600' },
  txt: { icon: FileText, color: 'text-neutral-500' },

  // ── Fonts ──
  eot: { icon: FileType, color: 'text-red-400' },
  otf: { icon: FileType, color: 'text-red-500' },
  ttf: { icon: FileType, color: 'text-red-500' },
  woff: { icon: FileType, color: 'text-red-400' },
  woff2: { icon: FileType, color: 'text-red-400' },

  // ── Images ──
  bmp: { icon: Image, color: 'text-purple-400' },
  gif: { icon: Image, color: 'text-purple-400' },
  ico: { icon: Image, color: 'text-purple-400' },
  jpeg: { icon: Image, color: 'text-purple-500' },
  jpg: { icon: Image, color: 'text-purple-500' },
  png: { icon: Image, color: 'text-purple-500' },
  svg: { icon: Palette, color: 'text-amber-500' },
  tiff: { icon: Image, color: 'text-purple-400' },
  webp: { icon: Image, color: 'text-purple-400' },

  // ── Audio ──
  aac: { icon: Music2, color: 'text-pink-400' },
  flac: { icon: Music2, color: 'text-pink-400' },
  m4a: { icon: Music2, color: 'text-pink-400' },
  mp3: { icon: Music2, color: 'text-pink-500' },
  ogg: { icon: Music2, color: 'text-pink-400' },
  wav: { icon: Music2, color: 'text-pink-500' },

  // ── Video ──
  avi: { icon: Video, color: 'text-rose-500' },
  mkv: { icon: Video, color: 'text-rose-400' },
  mov: { icon: Video, color: 'text-rose-500' },
  mp4: { icon: Video, color: 'text-rose-500' },
  webm: { icon: Video, color: 'text-rose-400' },

  // ── Programming languages ──
  c: { icon: Cpu, color: 'text-blue-600' },
  cc: { icon: Cpu, color: 'text-blue-700' },
  cpp: { icon: Cpu, color: 'text-blue-700' },
  cs: { icon: Hexagon, color: 'text-purple-600' },
  go: { icon: Hexagon, color: 'text-cyan-500' },
  h: { icon: Cpu, color: 'text-blue-400' },
  hpp: { icon: Cpu, color: 'text-blue-500' },
  java: { icon: Coffee, color: 'text-red-600' },
  jar: { icon: Coffee, color: 'text-red-500' },
  kt: { icon: Hexagon, color: 'text-violet-500' },
  kts: { icon: Hexagon, color: 'text-violet-400' },
  lua: { icon: SquareFunction, color: 'text-blue-500' },
  php: { icon: Blocks, color: 'text-violet-500' },
  py: { icon: Code2, color: 'text-emerald-500' },
  pyi: { icon: Code2, color: 'text-emerald-400' },
  pyw: { icon: Code2, color: 'text-emerald-500' },
  r: { icon: FlaskConical, color: 'text-blue-600' },
  rb: { icon: Gem, color: 'text-red-500' },
  rs: { icon: Cog, color: 'text-orange-600' },
  swift: { icon: Flame, color: 'text-orange-500' },

  // ── Web & markup ──
  css: { icon: Hash, color: 'text-blue-500' },
  erb: { icon: Gem, color: 'text-red-400' },
  gql: { icon: Workflow, color: 'text-pink-500' },
  graphql: { icon: Workflow, color: 'text-pink-500' },
  htm: { icon: Globe, color: 'text-orange-600' },
  html: { icon: Globe, color: 'text-orange-600' },
  less: { icon: Hash, color: 'text-indigo-500' },
  sass: { icon: Hash, color: 'text-pink-400' },
  scss: { icon: Hash, color: 'text-pink-500' },
  svelte: { icon: FileCode2, color: 'text-orange-500' },
  vue: { icon: FileCode2, color: 'text-emerald-500' },

  // ── JavaScript / TypeScript ──
  cjs: { icon: FileCode, color: 'text-yellow-500' },
  js: { icon: FileCode, color: 'text-yellow-500' },
  jsx: { icon: FileCode, color: 'text-yellow-500' },
  mjs: { icon: FileCode, color: 'text-yellow-500' },
  mts: { icon: FileCode2, color: 'text-blue-500' },
  ts: { icon: FileCode2, color: 'text-blue-500' },
  tsx: { icon: FileCode2, color: 'text-blue-500' },

  // ── Shell / scripts ──
  bash: { icon: Terminal, color: 'text-green-500' },
  bat: { icon: Terminal, color: 'text-neutral-500' },
  cmd: { icon: Terminal, color: 'text-neutral-500' },
  fish: { icon: Terminal, color: 'text-green-400' },
  ps1: { icon: Terminal, color: 'text-blue-400' },
  sh: { icon: Terminal, color: 'text-green-500' },
  zsh: { icon: Terminal, color: 'text-green-400' },

  // ── Misc ──
  ipynb: { icon: NotebookPen, color: 'text-orange-500' },
  proto: { icon: Box, color: 'text-green-500' },
  sql: { icon: Database, color: 'text-blue-500' },
};

const FILENAME_ICON_MAP: IconMap = {
  // ── Docker ──
  '.dockerignore': { icon: Box, color: 'text-neutral-500' },
  'docker-compose.yml': { icon: Box, color: 'text-blue-500' },
  'docker-compose.yaml': { icon: Box, color: 'text-blue-500' },
  Dockerfile: { icon: Box, color: 'text-blue-500' },

  // ── Git ──
  '.gitattributes': { icon: Settings, color: 'text-neutral-500' },
  '.gitignore': { icon: Settings, color: 'text-neutral-500' },
  '.gitmodules': { icon: Settings, color: 'text-neutral-500' },

  // ── Editor / formatter config ──
  '.editorconfig': { icon: Settings, color: 'text-neutral-500' },
  '.prettierignore': { icon: Settings, color: 'text-neutral-500' },
  '.prettierrc': { icon: Settings, color: 'text-pink-400' },

  // ── ESLint ──
  '.eslintrc': { icon: Settings, color: 'text-violet-500' },
  '.eslintrc.cjs': { icon: Settings, color: 'text-violet-500' },
  '.eslintrc.js': { icon: Settings, color: 'text-violet-500' },
  '.eslintrc.json': { icon: Settings, color: 'text-violet-500' },
  'eslint.config.js': { icon: Settings, color: 'text-violet-500' },
  'eslint.config.mjs': { icon: Settings, color: 'text-violet-500' },

  // ── Env files ──
  '.env': { icon: Shield, color: 'text-yellow-600' },
  '.env.development': { icon: Shield, color: 'text-yellow-500' },
  '.env.example': { icon: Shield, color: 'text-yellow-400' },
  '.env.local': { icon: Shield, color: 'text-yellow-600' },
  '.env.production': { icon: Shield, color: 'text-yellow-600' },

  // ── Package managers ──
  'package.json': { icon: Braces, color: 'text-green-500' },
  'package-lock.json': { icon: Lock, color: 'text-neutral-500' },
  'pnpm-lock.yaml': { icon: Lock, color: 'text-orange-400' },

  // ── Build / bundler config ──
  '.babelrc': { icon: Settings, color: 'text-yellow-500' },
  'babel.config.js': { icon: Settings, color: 'text-yellow-500' },
  'postcss.config.js': { icon: Cog, color: 'text-red-400' },
  'tailwind.config.js': { icon: Hash, color: 'text-cyan-500' },
  'tailwind.config.ts': { icon: Hash, color: 'text-cyan-500' },
  'vite.config.js': { icon: Flame, color: 'text-purple-500' },
  'vite.config.ts': { icon: Flame, color: 'text-purple-500' },
  'webpack.config.js': { icon: Cog, color: 'text-blue-500' },

  // ── TypeScript / JS config ──
  'jsconfig.json': { icon: Braces, color: 'text-yellow-500' },
  'tsconfig.json': { icon: Braces, color: 'text-blue-500' },

  // ── C/C++ build ──
  'CMakeLists.txt': { icon: Cog, color: 'text-blue-500' },
  Makefile: { icon: Terminal, color: 'text-neutral-500' },

  // ── Language-specific manifests ──
  'Cargo.toml': { icon: Cog, color: 'text-orange-600' },
  'Cargo.lock': { icon: Lock, color: 'text-orange-400' },
  Gemfile: { icon: Gem, color: 'text-red-500' },
  'Gemfile.lock': { icon: Lock, color: 'text-red-400' },
  'go.mod': { icon: Hexagon, color: 'text-cyan-500' },
  'go.sum': { icon: Lock, color: 'text-cyan-400' },
  'requirements.txt': { icon: FileText, color: 'text-emerald-400' },

  // ── Documentation ──
  'CHANGELOG.md': { icon: Scroll, color: 'text-blue-400' },
  LICENSE: { icon: FileCheck, color: 'text-neutral-500' },
  'LICENSE.md': { icon: FileCheck, color: 'text-neutral-500' },
  'README.md': { icon: BookOpen, color: 'text-blue-500' },
};

/**
 * Resolve a file icon and color for a given filename.
 * Resolution order: exact filename → .env prefix → extension → fallback (File icon).
 */
export function getFileIconData(filename: string): FileIconData {
  if (FILENAME_ICON_MAP[filename]) {
    return FILENAME_ICON_MAP[filename];
  }

  if (filename.startsWith('.env')) {
    return { icon: Shield, color: 'text-yellow-600' };
  }

  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension && FILE_ICON_MAP[extension]) {
    return FILE_ICON_MAP[extension];
  }

  return { icon: File, color: 'text-neutral-500 dark:text-neutral-400' };
}
