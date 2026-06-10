// ---------------------------------------------------------------------------
// Generic STT Provider — adapts any STT HTTP API to the STTProvider interface.
// Supports two request types: multipart (OpenAI-compatible) and json (base64).
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { STTProvider, STTInput, STTResult } from './types.js';

export interface GenericSTTConfig {
  /** Full API URL (required). */
  endpoint: string;
  /** API key (optional for local services). */
  apiKey?: string;
  /** Request type: 'multipart' (FormData) or 'json' (base64 JSON body). */
  requestType: 'multipart' | 'json';
  /** Model name sent to the API (multipart mode only). */
  model?: string;
  /** FormData / JSON field name for the audio file. Default 'file'. */
  audioFieldName?: string;
  /** Field name for the language parameter. Default 'language'. */
  languageFieldName?: string;
  /** Extra fields to append to every request. */
  extraFields?: Record<string, string>;
  /** JSONPath to extract the text from the response. Default 'text'. */
  responseTextField?: string;
  /** Authorization header prefix. Default 'Bearer'. */
  authPrefix?: string;
}

export class GenericSTTProvider implements STTProvider {
  readonly id = 'generic';

  constructor(private config: GenericSTTConfig) {}

  isAvailable(): boolean {
    return !!this.config.endpoint;
  }

  async transcribe(input: STTInput): Promise<STTResult> {
    const cfg = this.config;
    const audioBuffer = await readFile(input.audioPath);
    const fileName = path.basename(input.audioPath);

    let response: Response;
    if (cfg.requestType === 'multipart') {
      const formData = new FormData();
      formData.append(cfg.audioFieldName ?? 'file', new Blob([audioBuffer]), fileName);
      if (cfg.model) formData.append('model', cfg.model);
      if (input.language && input.language !== 'auto') {
        formData.append(cfg.languageFieldName ?? 'language', input.language);
      }
      if (cfg.extraFields) {
        for (const [k, v] of Object.entries(cfg.extraFields)) formData.append(k, v);
      }
      response = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: this.authHeaders(cfg),
        body: formData,
      });
    } else {
      // json mode: send audio as base64 in JSON body
      const body: Record<string, unknown> = {
        [cfg.audioFieldName ?? 'audio']: audioBuffer.toString('base64'),
        [cfg.languageFieldName ?? 'language']: input.language ?? 'auto',
      };
      if (cfg.extraFields) Object.assign(body, cfg.extraFields);
      response = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(cfg),
        },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      throw new Error(
        `STT API error (${response.status}): ${await response.text().catch(() => '<unreadable>')}`,
      );
    }

    const json = (await response.json()) as Record<string, unknown>;
    const text = cfg.responseTextField
      ? this.extractByPath(json, cfg.responseTextField)
      : json.text;

    if (typeof text !== 'string') {
      throw new Error(
        `Unexpected STT response: missing '${cfg.responseTextField ?? 'text'}' field`,
      );
    }

    return { text, providerId: this.id, durationMs: 0 };
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private authHeaders(cfg: GenericSTTConfig): Record<string, string> {
    return cfg.apiKey
      ? { Authorization: `${cfg.authPrefix ?? 'Bearer'} ${cfg.apiKey}` }
      : {};
  }

  /** Simple JSON path extraction: "data[0].text" → obj.data[0].text */
  private extractByPath(obj: Record<string, unknown>, pathStr: string): unknown {
    return pathStr.split('.').reduce((acc: unknown, key) => {
      if (acc === null || acc === undefined) return undefined;
      const arrMatch = key.match(/^(.+)\[(\d+)\]$/);
      if (arrMatch) {
        const arr = (acc as Record<string, unknown>)[arrMatch[1]];
        return Array.isArray(arr) ? arr[parseInt(arrMatch[2], 10)] : undefined;
      }
      return (acc as Record<string, unknown>)[key];
    }, obj);
  }
}
