// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the image_to_text tool
// ---------------------------------------------------------------------------
// Analyzes a local image file using a vision-capable model and returns a
// text description. Uses the VisionBridge's model resolution and the
// pi-mono completeSimple API.
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const imageToTextCapability: ToolCapabilityDescriptor = {
  category: 'multimodal',
  readOnly: true,
  readsFiles: true,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read',
  approvalDefault: 'none',
};

const SUPPORTED_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export function createImageToTextToolDefinition(): ToolDefinition {
  return {
    name: 'image_to_text',
    label: 'Image to Text',
    description: 'Analyze a local image and return a text description.',
    category: 'multimodal',
    parametersSchema: Type.Object({
      imagePath: Type.String({ description: 'Path to the image file' }),
      prompt: Type.Optional(Type.String({ description: 'Optional analysis instruction for the vision model' })),
    }),
    capability: imageToTextCapability,
    execute: async (args: { imagePath: string; prompt?: string }, ctx) => {
      const resolvedPath = resolve(ctx.cwd, args.imagePath);

      // Read file
      let buffer: Buffer;
      try {
        buffer = readFileSync(resolvedPath);
      } catch {
        return errorResult(`Cannot read image file: ${args.imagePath}`);
      }

      // Detect MIME type from extension
      const ext = resolvedPath.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = SUPPORTED_TYPES[ext];
      if (!mimeType) {
        return errorResult(`Unsupported image format: .${ext} (supported: jpg, png, gif, webp, bmp)`);
      }

      // Base64 encode image content
      const base64 = buffer.toString('base64');

      // Resolve the vision model reference from config
      const config = ctx.services.config;
      const bridgeCfg = (config.multimodal?.image?.bridge ?? {}) as Record<string, unknown>;
      const legacyVision = (config.visionBridge ?? {}) as Record<string, unknown>;
      const bridgeEnabled = (bridgeCfg.enabled ?? legacyVision.enabled ?? false) as boolean;
      if (!bridgeEnabled) {
        return errorResult(
          'Vision Bridge is not enabled. Set multimodal.image.bridge.enabled=true in config.',
        );
      }

      const modelRef = String(bridgeCfg.modelRef ?? legacyVision.modelRef ?? '');
      if (!modelRef) {
        return errorResult('No vision bridge model configured (multimodal.image.bridge.modelRef).');
      }

      const idx = modelRef.indexOf('/');
      if (idx === -1) {
        return errorResult(
          `Invalid model reference format: "${modelRef}". Expected "provider/model-id".`,
        );
      }
      const provider = modelRef.slice(0, idx);
      const modelId = modelRef.slice(idx + 1);

      // Resolve API key: bridge config → legacy visionBridge → customProviders
      let apiKey: string | undefined = String(bridgeCfg.apiKey ?? legacyVision.apiKey ?? '') || undefined;
      if (!apiKey && config.customProviders) {
        const cp = config.customProviders.find(p => p.provider === provider);
        apiKey = cp?.apiKey;
      }

      // Dynamically import pi-ai (avoids circular dependency at module level)
      const { getModel, completeSimple } = await import('@earendil-works/pi-ai');
      const visionModel = getModel(provider as any, modelId as any) as any;
      if (!visionModel) {
        return errorResult(`Vision model not found: ${modelRef}`);
      }

      // Build image content block for pi-mono ImageContent
      const imageContent = { type: 'image' as const, data: base64, mimeType };

      try {
        const finalPrompt = args.prompt ?? 'Describe this image in detail.';
        const message = {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: finalPrompt },
            imageContent,
          ],
          timestamp: Date.now(),
        };

        const response = await completeSimple(
          visionModel,
          {
            systemPrompt:
              'You are a precise image analyst. Describe the image accurately based on the user\'s request.',
            messages: [message],
            tools: [],
          },
          {
            apiKey,
            maxTokens: 900,
            signal: AbortSignal.timeout(Number(bridgeCfg.timeoutMs ?? legacyVision.timeoutMs ?? 120_000)),
          },
        );

        const text = response.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
        return textResult(text || '(empty response)');
      } catch (err: any) {
        return errorResult(`Vision analysis failed: ${err.message ?? String(err)}`);
      }
    },
  };
}
