import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Check if running from compiled dist/ (production mode)
function isCompiledMode(): boolean {
  // In production (Electron / compiled deployment), the server code lives in
  // a 'dist/' or 'server-dist/' directory. Both indicate compiled mode where
  // only .js files are available and .ts files cannot be imported directly.
  return import.meta.url.includes('/dist/') || import.meta.url.includes('/server-dist/');
}

function toImportPath(filePath: string): string {
  // Convert to file:// URL for cross-platform ESM import compatibility
  return pathToFileURL(filePath).href;
}

function resolveModulePath(baseDir: string, manifestId: string, mainFile: string): string | null {
  const extDir = join(baseDir, manifestId);

  // 1. Compiled .js in dist/ directory (production / compiled mode)
  if (isCompiledMode()) {
    const distJsPath = join('dist', baseDir, manifestId, mainFile);
    if (existsSync(distJsPath)) return distJsPath;
  }

  // 2. Compiled .js in source extensions dir (dev build)
  const jsPath = join(extDir, mainFile);
  if (existsSync(jsPath)) return jsPath;

  // 3. Source .ts (dev mode with tsx or ts-node)
  if (mainFile.endsWith('.js')) {
    const tsPath = join(extDir, mainFile.replace(/\.js$/, '.ts'));
    if (existsSync(tsPath)) return tsPath;
  }

  // 4. Source .ts in dist/ directory (unusual but possible)
  if (isCompiledMode() && mainFile.endsWith('.js')) {
    const distTsPath = join('dist', baseDir, manifestId, mainFile.replace(/\.js$/, '.ts'));
    if (existsSync(distTsPath)) return distTsPath;
  }

  return null;
}

import type { ExtensionManifest, ExtensionAPI } from './types.js';

export class ExtensionLoader {
  async scan(dir: string): Promise<ExtensionManifest[]> {
    if (!existsSync(dir)) return [];
    const manifests: ExtensionManifest[] = [];
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const extDir = join(dir, entry);
        try {
          if (!statSync(extDir).isDirectory()) continue;
          const manifestPath = join(extDir, 'extension.json');
          if (!existsSync(manifestPath)) continue;
          const raw = readFileSync(manifestPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const manifest = this.validateManifest(parsed);
          if (manifest) {
            manifests.push(manifest);
          }
        } catch {
          // skip invalid extension directories
        }
      }
    } catch {
      // directory read failed
    }
    return manifests;
  }

  validateManifest(raw: unknown): ExtensionManifest | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) return null;
    if (typeof m.name !== 'string' || !m.name) return null;
    if (typeof m.version !== 'string' || !m.version) return null;
    if (typeof m.kind !== 'string' || !['tool', 'channel', 'command', 'hook'].includes(m.kind)) return null;
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      kind: m.kind as ExtensionManifest['kind'],
      channel_type: typeof m.channel_type === 'string' ? m.channel_type : undefined,
      main: typeof m.main === 'string' ? m.main : 'index.js',
      description: typeof m.description === 'string' ? m.description : undefined,
    };
  }

  async load(manifest: ExtensionManifest, baseDir: string, api: ExtensionAPI): Promise<void> {
    try {
      const mainFile = manifest.main || 'index.js';
      const modulePath = resolveModulePath(baseDir, manifest.id, mainFile);
      if (!modulePath) {
        throw new Error(`Module entry not found: ${join(baseDir, manifest.id, mainFile)}`);
      }
      const importUrl = toImportPath(modulePath);
      const mod = await import(importUrl);
      if (typeof mod.default !== 'function') {
        throw new Error(`Extension module must export a default function`);
      }
      await mod.default(api);
    } catch (err) {
      throw err;
    }
  }
}
