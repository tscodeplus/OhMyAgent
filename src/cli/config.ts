import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function detectProjectDir(): string {
  // 1. Explicit override
  if (process.env.OHMYAGENT_HOME) {
    return process.env.OHMYAGENT_HOME;
  }

  // 2. Auto-detect from CLI's own location
  //    dist/src/cli/config.js → 3 levels up = project root
  try {
    const configDir = fileURLToPath(new URL('.', import.meta.url));
    const detected = join(configDir, '..', '..', '..');
    // Verify by checking for package.json
    if (existsSync(join(detected, 'package.json'))) {
      return detected;
    }
  } catch {
    // import.meta.url not available or not in expected structure
  }

  // 3. Default install location
  return join(homedir(), '.ohmyagent');
}

const HOME = detectProjectDir();

export const PROJECT_DIR = HOME;
export const DATA_DIR = join(HOME, 'data');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const LOG_FILE = join(LOG_DIR, 'ohmyagent.log');
export const PID_FILE = join(HOME, 'ohmyagent.pid');
export const DB_PATH = join(DATA_DIR, 'app.db');
export const DIST_INDEX = join(HOME, 'dist', 'src', 'index.js');
export const PORT = parseInt(process.env.OHMYAGENT_PORT || process.env.PORT || '9191', 10);
