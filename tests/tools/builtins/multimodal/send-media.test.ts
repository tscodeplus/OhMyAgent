// ---------------------------------------------------------------------------
// Tests for webui_send_media tool URL format
//
// Gateway-local files must use /api/files/serve (token auth, no expiry,
// survives restarts) — never short-lived /dl/ signing tokens that get
// invalidated when the per-process signing key changes.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSendMediaTool } from '../../../../src/tools/builtins/multimodal/send-media-tool.js';
import { extractToolText } from '../../../helpers/tool-result.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'send-media-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFile(name: string, content = 'test-content'): string {
  const p = join(tmpDir, name);
  writeFileSync(p, Buffer.from(content));
  return p;
}

async function runTool(filePath: string): Promise<any> {
  const tool = createSendMediaTool();
  return await tool.execute('call_1', { filePath });
}

describe('webui_send_media URL format', () => {
  it('returns a /api/files/serve URL (no /dl/ token) for an image', async () => {
    const file = makeFile('photo.png', 'fake-png-bytes');
    const result = await runTool(file);

    const expectedUrl = `/api/files/serve?path=${encodeURIComponent(file)}`;
    expect(result.details.serveUrl).toBe(expectedUrl);
    expect(extractToolText(result)).toContain(`![photo.png](${expectedUrl})`);
    expect(extractToolText(result)).not.toContain('/dl/');
  });

  it('returns a serve URL for a video', async () => {
    const file = makeFile('clip.mp4', 'fake-mp4-bytes');
    const result = await runTool(file);

    const expectedUrl = `/api/files/serve?path=${encodeURIComponent(file)}`;
    expect(result.details.serveUrl).toBe(expectedUrl);
    expect(extractToolText(result)).toContain(`[clip.mp4](${expectedUrl})`);
    expect(extractToolText(result)).not.toContain('/dl/');
  });

  it('returns a serve URL for a generic file', async () => {
    const file = makeFile('notes.txt', 'hello');
    const result = await runTool(file);

    const expectedUrl = `/api/files/serve?path=${encodeURIComponent(file)}`;
    expect(result.details.serveUrl).toBe(expectedUrl);
    expect(extractToolText(result)).toContain(`[notes.txt](${expectedUrl})`);
    expect(extractToolText(result)).not.toContain('/dl/');
  });

  it('reports an error for a missing file', async () => {
    const missing = join(tmpDir, 'nope.png');
    const result = await runTool(missing);
    expect(extractToolText(result)).toContain('File not found');
    expect(result.details).toBeNull();
  });
});
