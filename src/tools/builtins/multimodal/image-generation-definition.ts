// ---------------------------------------------------------------------------
// v4 ToolDefinition for the image_generation tool
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import type { ImageGenerationProvider } from './image-generation-provider.js';
import { NoOpImageGenerationProvider } from './image-generation-provider.js';

export const imageGenerationCapability: ToolCapabilityDescriptor = {
  category: 'multimodal',
  readOnly: false,
  readsFiles: false,
  writesFiles: true,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'write',
  approvalDefault: 'mutating',
};

export function createImageGenerationToolDefinition(
  provider?: ImageGenerationProvider,
): ToolDefinition {
  const imageGenProvider: ImageGenerationProvider =
    provider ?? new NoOpImageGenerationProvider();

  return {
    name: 'image_generation',
    label: 'Image Generation',
    description:
      'Generate an image from a text prompt.',
    category: 'multimodal',
    parametersSchema: Type.Object({
      prompt: Type.String({
        description: 'Image generation prompt. Supports up to 32000 characters.',
      }),
      size: Type.Optional(
        Type.Union(
          [
            Type.Literal('1024x1024'),
            Type.Literal('1024x1536'),
            Type.Literal('1536x1024'),
            Type.Literal('2000x1000'),
            Type.Literal('1000x2000'),
            Type.Literal('2000x667'),
            Type.Literal('667x2000'),
          ],
          { description: 'Image size (width x height). Supports additional sizes like 2000x1000 for GPT-Image-2.' },
        ),
      ),
      quality: Type.Optional(
        Type.Union(
          [Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('auto')],
          { description: 'Image quality: low, medium, high, or auto. Higher = better detail, more cost. (GPT-Image-2)' },
        ),
      ),
      outputFormat: Type.Optional(
        Type.Union(
          [Type.Literal('png'), Type.Literal('webp'), Type.Literal('jpeg')],
          { description: 'Output image format. Default is png. (GPT-Image-2)' },
        ),
      ),
      n: Type.Optional(
        Type.Number({ description: 'Number of images to generate. Default 1. Provider-dependent.' }),
      ),
      seed: Type.Optional(
        Type.Number({ description: 'Seed for reproducible results. Provider-dependent.' }),
      ),
      thinking: Type.Optional(
        Type.Union(
          [Type.Literal('off'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')],
          { description: 'Reasoning budget before rendering. Higher = better text/diagrams. (GPT-Image-2)' },
        ),
      ),
      outputFileName: Type.Optional(
        Type.String({ description: 'Output file name (without extension)' }),
      ),
    }),
    capability: imageGenerationCapability,
    execute: async (
      args: {
        prompt: string;
        size?: string;
        quality?: string;
        outputFormat?: string;
        n?: number;
        seed?: number;
        thinking?: string;
        outputFileName?: string;
      },
      ctx,
    ) => {
      const config = ctx.services.config;
      const genConfig = config.multimodal?.imageGeneration;

      // Check if image generation is enabled
      if (!genConfig?.enabled) {
        return errorResult(
          'Image generation is not enabled. Set multimodal.imageGeneration.enabled=true in config.',
        );
      }

      // Check if model ref is configured
      const modelRef = genConfig.modelRef ?? '';
      if (!modelRef) {
        return errorResult(
          'No image generation model configured. Set multimodal.imageGeneration.modelRef in config.',
        );
      }

      // Validate prompt
      if (!args.prompt || typeof args.prompt !== 'string') {
        return errorResult(
          'Missing or invalid "prompt" parameter. A text prompt is required for image generation.',
        );
      }
      if (args.prompt.length > genConfig.maxPromptChars) {
        return errorResult(
          `Prompt exceeds maximum length of ${genConfig.maxPromptChars} characters (current: ${args.prompt.length}).`,
        );
      }

      // Determine output file name
      let sanitizedName: string;
      if (args.outputFileName) {
        sanitizedName = path
          .basename(args.outputFileName)
          .replace(/[^a-zA-Z0-9_\-]/g, '_');
      } else {
        sanitizedName = `generated_${Date.now()}`;
      }

      const outputDir = path.resolve(genConfig.outputDir);

      try {
        // Generate the image
        const result = await imageGenProvider.generate({
          prompt: args.prompt,
          size: (args.size as any) ?? '1024x1024',
          modelRef,
          quality: args.quality as any,
          outputFormat: args.outputFormat as any,
          n: args.n,
          seed: args.seed,
          thinking: args.thinking as any,
        });

        // Determine file extension from mime type
        const mimeToExt: Record<string, string> = {
          'image/png': '.png',
          'image/jpeg': '.jpg',
          'image/webp': '.webp',
        };
        const ext = mimeToExt[result.mimeType] ?? '.png';
        const outputPath = path.join(outputDir, `${sanitizedName}${ext}`);

        const pathDecision = ctx.services.policyCenter?.evaluatePathAccess({
          path: outputPath,
          operation: 'write',
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          scope: ctx.policyScope,
        });
        if (pathDecision && !pathDecision.allowed) {
          return errorResult(pathDecision.reason ?? `Write access denied: ${outputPath}`);
        }

        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write the image file
        fs.writeFileSync(outputPath, result.data);

        const serveUrl = `/api/files/serve?path=${encodeURIComponent(outputPath)}`;
        return textResult(`Image saved to ${outputPath}

![Generated image](${serveUrl})`);
      } catch (err: any) {
        return errorResult(
          `Image generation failed: ${err.message ?? String(err)}`,
        );
      }
    },
  };
}
