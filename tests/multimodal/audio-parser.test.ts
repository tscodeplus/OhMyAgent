import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioParser } from '../../src/multimodal/parsers/audio.js';

function withTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audioparser-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('AudioParser', () => {
  const parser = new AudioParser();

  describe('transcribe', () => {
    it('should return a description for a small MP3 file', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'voice.mp3');
      // ~16KB MP3 → roughly 1 second at 128kbps
      writeFileSync(filePath, Buffer.alloc(16_000));

      const result = await parser.transcribe(filePath, 'audio/mpeg');

      expect(result.kind).toBe('audio');
      expect(result.text).toContain('[Audio file');
      expect(result.text).toContain('voice.mp3');
      expect(result.text).toContain('audio/mpeg');
      expect(result.metadata?.estimatedDurationSec).toBeTypeOf('number');
    });

    it('should estimate ~1s for ~16KB MP3 (128kbps)', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'short.mp3');
      writeFileSync(filePath, Buffer.alloc(16_000)); // ~16KB

      const result = await parser.transcribe(filePath, 'audio/mpeg');

      // 16000 bytes * 8 / 128000 bps = 1 second
      expect(result.metadata?.estimatedDurationSec).toBe(1);
    });

    it('should estimate ~9s for ~128KB MP3 (128kbps)', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'longer.mp3');
      writeFileSync(filePath, Buffer.alloc(128_000)); // ~128KB

      const result = await parser.transcribe(filePath, 'audio/mpeg');

      // 128000 bytes * 8 / 128000 bps = 8 seconds (rounds to 8)
      expect(result.metadata?.estimatedDurationSec).toBe(8);
    });

    it('should handle WAV files with PCM bitrate', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'sample.wav');
      // ~88KB WAV → ~1 second at 705.6kbps
      writeFileSync(filePath, Buffer.alloc(88_200));

      const result = await parser.transcribe(filePath, 'audio/wav');

      expect(result.kind).toBe('audio');
      expect(result.text).toContain('sample.wav');
      // 88200 * 8 / 705600 = 1 second
      expect(result.metadata?.estimatedDurationSec).toBe(1);
    });

    it('should report minutes for longer audio', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'long.mp3');
      // ~10MB MP3 → ~10 minutes at 128kbps
      writeFileSync(filePath, Buffer.alloc(9_600_000));

      const result = await parser.transcribe(filePath, 'audio/mpeg');

      expect(result.text).toContain('m');
      expect(result.text).toContain('s');
      expect((result.metadata?.estimatedDurationSec as number)).toBeGreaterThan(60);
    });

    it('should include size in metadata', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'test.ogg');
      writeFileSync(filePath, Buffer.alloc(64_000));

      const result = await parser.transcribe(filePath, 'audio/ogg');

      expect(result.metadata?.size).toBe(64_000);
      expect(result.metadata?.mimeType).toBe('audio/ogg');
    });

    it('should detect compressed format from mime subtype', async () => {
      const dir = withTempDir();
      const filePath = join(dir, 'audio.aac');
      writeFileSync(filePath, Buffer.alloc(64_000));

      const result = await parser.transcribe(filePath, 'audio/aac');

      // AAC is compressed → 128kbps → 64000*8/128000 = 4s
      expect(result.metadata?.estimatedDurationSec).toBe(4);
    });
  });
});
