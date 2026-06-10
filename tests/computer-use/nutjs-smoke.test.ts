// Smoke test for nut.js — only runs when a real display server is available.
// WSLg has DISPLAY but no X_GetImage support, so we skip screen capture there.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';

const isWSL = process.platform === 'linux' && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
const hasDisplay = !!process.env.DISPLAY || process.platform === 'darwin' || process.platform === 'win32';
const runSmoke = hasDisplay && !isWSL;

describe.runIf(runSmoke)('nut.js smoke test', () => {
  let screen: any;
  let mouse: any;

  beforeAll(async () => {
    const nut = await import('@nut-tree-fork/nut-js');
    screen = nut.screen;
    mouse = nut.mouse;
  });

  it('reads screen dimensions', async () => {
    const w = await screen.width();
    const h = await screen.height();
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });

  it('reads mouse position', async () => {
    const pos = await mouse.getPosition();
    expect(typeof pos.x).toBe('number');
    expect(typeof pos.y).toBe('number');
  });

  it('grabs screen content via grab()', async () => {
    const img = await screen.grab();
    expect(img).toBeDefined();
  });
});
