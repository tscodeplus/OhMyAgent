// ---------------------------------------------------------------------------
// v4 ToolDefinition for speech_to_text
// Transcribes an audio file to text using configured STT providers.
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import { statSync } from 'node:fs';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { createSTTProviders, transcribeWithFallback } from '../../../media-providers/stt/factory.js';

export const speechToTextCapability: ToolCapabilityDescriptor = {
  category: 'multimodal',
  readOnly: true,
  readsFiles: true,
  writesFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'read',
  approvalDefault: 'none',
};

export function createSpeechToTextToolDefinition(): ToolDefinition {
  return {
    name: 'speech_to_text',
    label: 'Speech to Text',
    description:
      'Transcribe an audio file to text using a configured speech-to-text provider. ' +
      'Supports audio formats like opus, mp3, wav, ogg. ' +
      'For Feishu voice messages, transcription happens automatically in private chats.',
    category: 'multimodal',
    parametersSchema: Type.Object({
      audioPath: Type.String({
        description: 'Path to the local audio file to transcribe',
      }),
      language: Type.Optional(
        Type.Union(
          [
            Type.Literal('zh'),
            Type.Literal('en'),
            Type.Literal('ja'),
            Type.Literal('ko'),
            Type.Literal('auto'),
          ],
          { description: 'Language hint for transcription. Default: auto' },
        ),
      ),
    }),
    capability: speechToTextCapability,
    execute: async (
      args: { audioPath: string; language?: string },
      ctx,
    ) => {
      const config = ctx.services.config;
      const sttConfig = config.multimodal?.stt;

      if (!sttConfig?.enabled) {
        return errorResult(
          'Speech-to-text is not enabled. Set multimodal.stt.enabled=true in config.',
        );
      }

      // Build provider chain from config (before reading files)
      const providerConfigs = sttConfig.providers ?? [];
      if (providerConfigs.length === 0) {
        return errorResult(
          'No STT provider configured. Configure multimodal.stt.providers.',
        );
      }

      const providers = createSTTProviders(providerConfigs);
      if (providers.length === 0) {
        return errorResult(
          'No STT provider available. Check your provider configuration (API keys or endpoints).',
        );
      }

      // Validate file exists
      try {
        const stat = statSync(args.audioPath);
        const maxBytes = (sttConfig.maxFileSizeMb ?? 25) * 1024 * 1024;
        if (stat.size > maxBytes) {
          return errorResult(
            `Audio file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${sttConfig.maxFileSizeMb ?? 25}MB)`,
          );
        }
      } catch {
        return errorResult(`Cannot read audio file: ${args.audioPath}`);
      }

      try {
        const result = await transcribeWithFallback(providers, {
          audioPath: args.audioPath,
          language: args.language ?? 'auto',
        });

        return textResult(result.text, {
          language: result.language,
          durationMs: result.durationMs,
          providerId: result.providerId,
        });
      } catch (err) {
        return errorResult(
          `Speech-to-text failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
