// ---------------------------------------------------------------------------
// STT Provider factory — creates providers from config, assembles fallback chain
// ---------------------------------------------------------------------------

import { GenericSTTProvider } from './generic-provider.js';
import { OpenAIWhisperProvider } from './openai-whisper.js';
import type { STTProvider } from './types.js';
import { runWithFallback } from '../types.js';

export interface STTProviderConfig {
  id: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Generic Provider fields */
  endpoint?: string;
  requestType?: 'multipart' | 'json';
  audioFieldName?: string;
  languageFieldName?: string;
  responseTextField?: string;
  extraFields?: Record<string, string>;
  authPrefix?: string;
}

export function createSTTProviders(configs: STTProviderConfig[]): STTProvider[] {
  return configs
    .map(cfg => {
      switch (cfg.id) {
        // --- Generic Provider: any OpenAI-compatible or custom STT API ---
        case 'generic':
          if (!cfg.endpoint) return null;
          return new GenericSTTProvider({
            endpoint: cfg.endpoint,
            apiKey: cfg.apiKey,
            requestType: cfg.requestType ?? 'multipart',
            model: cfg.model,
            audioFieldName: cfg.audioFieldName,
            languageFieldName: cfg.languageFieldName,
            responseTextField: cfg.responseTextField,
            extraFields: cfg.extraFields,
            authPrefix: cfg.authPrefix,
          });

        // --- Named Providers ---
        case 'openai-whisper':
          if (!cfg.apiKey) return null;
          return new OpenAIWhisperProvider({
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl,
            model: cfg.model,
          });

        // Placeholder for future named providers (doubao-stt, azure-stt)
        // case 'doubao-stt':
        // case 'azure-stt':

        default:
          return null;
      }
    })
    .filter((p) => p !== null) as STTProvider[];
}

/**
 * Transcribe audio using the first available provider in the fallback chain.
 */
export async function transcribeWithFallback(
  providers: STTProvider[],
  input: Parameters<STTProvider['transcribe']>[0],
): Promise<ReturnType<STTProvider['transcribe']>> {
  const { result } = await runWithFallback(providers, p => p.transcribe(input));
  return result;
}
