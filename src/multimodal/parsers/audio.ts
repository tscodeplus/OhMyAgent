import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { MediaParseResult } from '../types.js';

export class AudioParser {
  async transcribe(filePath: string, mimeType: string): Promise<MediaParseResult> {
    const stat = statSync(filePath);
    const name = basename(filePath);

    // Rough duration estimate from file size
    const compressedFormats = ['audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/ogg', 'audio/wma'];
    const isCompressed = compressedFormats.some(f => mimeType.includes(f) || mimeType.includes(f.split('/')[1] ?? ''));
    const bitsPerSecond = isCompressed ? 128_000 : 705_600; // compressed vs PCM WAV
    const seconds = Math.round((stat.size * 8) / bitsPerSecond);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const duration = minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;

    return {
      kind: 'audio',
      text: `[Audio file: ${name}, format: ${mimeType}, size: ${stat.size} bytes, estimated duration: ${duration}]`,
      metadata: { size: stat.size, mimeType, estimatedDurationSec: seconds },
    };
  }
}
