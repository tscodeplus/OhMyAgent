// ---------------------------------------------------------------------------
// v4 ToolDefinition for the video_generation tool
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import type { VideoGenerationProvider } from './video-generation-provider.js';
import { NoOpVideoGenerationProvider } from './video-generation-provider.js';

export const videoGenerationCapability: ToolCapabilityDescriptor = {
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

export function createVideoGenerationToolDefinition(
  provider?: VideoGenerationProvider,
): ToolDefinition {
  const videoGenProvider: VideoGenerationProvider =
    provider ?? new NoOpVideoGenerationProvider();

  return {
    name: 'video_generation',
    label: 'Video Generation',
    description:
      'Generate a video from a text prompt.',
    category: 'multimodal',
    parametersSchema: Type.Object({
      prompt: Type.String({
        description: 'Video generation prompt',
      }),
      seconds: Type.Optional(
        Type.String({ description: 'Video duration in seconds (e.g. "5.0" for 5 seconds)' }),
      ),
      size: Type.Optional(
        Type.String({ description: 'Video resolution (e.g. "1280x768")' }),
      ),
      aspectRatio: Type.Optional(
        Type.Union(
          [
            Type.Literal('16:9'),
            Type.Literal('9:16'),
            Type.Literal('1:1'),
            Type.Literal('4:3'),
            Type.Literal('3:4'),
            Type.Literal('21:9'),
          ],
          { description: 'Video aspect ratio. Seedance-style providers.' },
        ),
      ),
      seed: Type.Optional(
        Type.Number({ description: 'Seed for reproducible results. Provider-dependent.' }),
      ),
      outputFileName: Type.Optional(
        Type.String({ description: 'Output file name (without extension)' }),
      ),
    }),
    capability: videoGenerationCapability,
    execute: async (
      args: {
        prompt: string;
        seconds?: string;
        size?: string;
        aspectRatio?: string;
        seed?: number;
        outputFileName?: string;
      },
      ctx,
    ) => {
      const config = ctx.services.config;
      const genConfig = config.multimodal?.videoGeneration;

      // Check if video generation is enabled
      if (!genConfig?.enabled) {
        return errorResult(
          'Video generation is not enabled. Set multimodal.videoGeneration.enabled=true in config.',
        );
      }

      // Check if model ref is configured
      const modelRef = genConfig.modelRef ?? '';
      if (!modelRef) {
        return errorResult(
          'No video generation model configured. Set multimodal.videoGeneration.modelRef in config.',
        );
      }

      // Validate prompt
      if (!args.prompt || typeof args.prompt !== 'string') {
        return errorResult(
          'Missing or invalid "prompt" parameter. A text prompt is required for video generation.',
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
        sanitizedName = `generated_video_${Date.now()}`;
      }

      const outputDir = path.resolve(genConfig.outputDir);

      try {
        // Generate the video
        const result = await videoGenProvider.generate({
          prompt: args.prompt,
          seconds: args.seconds ?? genConfig.defaultSeconds,
          size: args.size ?? genConfig.defaultSize,
          aspectRatio: args.aspectRatio as any,
          seed: args.seed,
          modelRef,
        });

        const ext = '.mp4';
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

        // Write the video file
        fs.writeFileSync(outputPath, result.data);

        const serveUrl = `/api/files/serve?path=${encodeURIComponent(outputPath)}`;
        return textResult(`Video saved to ${outputPath}

Download: [${path.basename(outputPath)}](${serveUrl})`);
      } catch (err: any) {
        return errorResult(
          `Video generation failed: ${err.message ?? String(err)}`,
        );
      }
    },
  };
}
