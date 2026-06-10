// ---------------------------------------------------------------------------
// OpenAI Whisper STT Provider
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { STTProvider, STTInput, STTResult } from './types.js';

export class OpenAIWhisperProvider implements STTProvider {
  readonly id = 'openai-whisper';

  constructor(private options: {
    apiKey: string;
    /** Default: https://api.openai.com */
    baseUrl?: string;
    /** Default: whisper-1 */
    model?: string;
  }) {}

  isAvailable(): boolean {
    return !!this.options.apiKey;
  }

  async transcribe(input: STTInput): Promise<STTResult> {
    const audioBuffer = await readFile(input.audioPath);
    const model = this.options.model ?? 'whisper-1';
    const baseUrl = this.options.baseUrl ?? 'https://api.openai.com';

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), path.basename(input.audioPath));
    formData.append('model', model);
    if (input.language && input.language !== 'auto') {
      formData.append('language', input.language);
    }
    formData.append('response_format', 'json');

    const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(
        `Whisper API error (${response.status}): ${await response.text().catch(() => '<unreadable>')}`,
      );
    }

    const json = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
    };

    return {
      text: json.text,
      language: json.language,
      durationMs: Math.round((json.duration ?? 0) * 1000),
      providerId: this.id,
    };
  }
}
