// ---------------------------------------------------------------------------
// Image / Video generation provider factories
// ---------------------------------------------------------------------------

import type { AppConfig } from '../../app/types.js';
import type { ImageGenerationProvider } from '../../tools/builtins/multimodal/image-generation-provider.js';
import { NoOpImageGenerationProvider } from '../../tools/builtins/multimodal/image-generation-provider.js';
import type { VideoGenerationProvider } from '../../tools/builtins/multimodal/video-generation-provider.js';
import { NoOpVideoGenerationProvider } from '../../tools/builtins/multimodal/video-generation-provider.js';
import {
  OpenAIImageGenerationProvider,
  resolveImageGenConfig,
  type ImageParamsMapping,
} from './openai-images-provider.js';
import {
  OpenAIVideoGenerationProvider,
  type OpenAIVideoGenConfig,
  type VideoResponseMapping,
  type VideoParamsMapping,
} from './openai-video-provider.js';

// ---------------------------------------------------------------------------
// Provider-specific presets
// ---------------------------------------------------------------------------

interface ProviderPreset {
  responseMapping?: VideoResponseMapping;
  paramsMapping?: VideoParamsMapping;
}

/**
 * Known provider presets. Keyed by provider name (the part before "/" in
 * modelRef). Add new providers here as needed.
 */
const VIDEO_PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // Agnes AI — standard /v1/video/generations with wrapped response
  agnes: {
    responseMapping: {
      statusField: 'data.status',
      successValue: 'SUCCESS',
      failureValues: ['FAILED', 'ERROR'],
      videoUrlPaths: ['data.data.remixed_from_video_id', 'data.result_url'],
      progressField: 'data.data.progress',
      endpointPath: '/v1/video/generations',
    },
    paramsMapping: {
      durationField: 'seconds',
      sizeField: 'size',
      referenceImagesField: 'image',
      referenceImagesMode: 'first',
    },
  },

  // Seedance via ElkAPI / Pixazo / other aggregators
  // Uses standard OpenAI-compatible /v1/video/generations, but with
  // different param names and a simpler status response envelope.
  bytedance: {
    responseMapping: {
      statusField: 'status',       // flat "status": "succeeded"
      successValue: 'succeeded',
      failureValues: ['failed', 'error'],
      videoUrlPaths: ['video_url', 'url', 'output_url', 'data.url'],
      progressField: 'progress',
      endpointPath: '/v1/video/generations',
    },
    paramsMapping: {
      durationField: 'duration',
      sizeField: 'size',
      aspectRatioField: 'aspect_ratio',
      referenceImagesField: 'references.images',
    },
  },

  // Generic OpenAI-compatible (default when no preset matches)
  openai: {
    responseMapping: {
      statusField: 'status',
      successValue: 'completed',
      failureValues: ['failed', 'error'],
      videoUrlPaths: ['video_url', 'url', 'output.video_url'],
      progressField: 'progress',
      endpointPath: '/v1/video/generations',
    },
    paramsMapping: {
      durationField: 'seconds',
      sizeField: 'size',
      referenceImagesField: 'references.images',
    },
  },
};

// ---------------------------------------------------------------------------
// Image provider presets
// ---------------------------------------------------------------------------

interface ImageProviderPreset {
  paramsMapping?: ImageParamsMapping;
}

/**
 * Known image generation provider presets. Keyed by provider name.
 */
const IMAGE_PROVIDER_PRESETS: Record<string, ImageProviderPreset> = {
  // Agnes AI — reference images via extra_body.image (array of URLs)
  agnes: {
    paramsMapping: {
      referenceImagesField: 'extra_body.image',
    },
  },

  // Generic OpenAI-compatible (default when no preset matches)
  openai: {
    paramsMapping: {
      referenceImagesField: 'references.images',
    },
  },
};

function getImageProviderPreset(providerName: string): ImageProviderPreset | undefined {
  if (IMAGE_PROVIDER_PRESETS[providerName]) {
    return IMAGE_PROVIDER_PRESETS[providerName];
  }
  for (const [key, preset] of Object.entries(IMAGE_PROVIDER_PRESETS)) {
    if (providerName.includes(key)) return preset;
  }
  return undefined;
}

function getVideoProviderPreset(providerName: string): ProviderPreset | undefined {
  // Direct match
  if (VIDEO_PROVIDER_PRESETS[providerName]) {
    return VIDEO_PROVIDER_PRESETS[providerName];
  }
  // Substring match for aggregator prefixes like "bytedance/seedance-2.0"
  for (const [key, preset] of Object.entries(VIDEO_PROVIDER_PRESETS)) {
    if (providerName.includes(key)) return preset;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Create an ImageGenerationProvider from AppConfig.
 *
 * Uses the modelRef from config.multimodal.imageGeneration to resolve
 * the provider (custom_providers or provider_keys) and create the
 * appropriate implementation.
 */
export function createImageGenerationProvider(
  config: AppConfig,
): ImageGenerationProvider {
  const genConfig = config.multimodal?.imageGeneration;
  if (!genConfig?.enabled || !genConfig?.modelRef) {
    return new NoOpImageGenerationProvider();
  }

  const resolved = resolveImageGenConfig(
    genConfig.modelRef,
    (config as any).customProviders ?? [],
    (config as any).providerKeys ?? {},
  );

  if (!resolved) {
    return new NoOpImageGenerationProvider();
  }

  // Auto-detect provider preset
  const preset = getImageProviderPreset(resolved.provider);

  return new OpenAIImageGenerationProvider({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    modelId: resolved.modelId,
    paramsMapping: preset?.paramsMapping,
  });
}

/**
 * Create a VideoGenerationProvider from AppConfig.
 *
 * Auto-detects the provider from modelRef and applies the correct
 * response/params mapping. Known providers like agnes, bytedance/seedance
 * are handled automatically; unknown providers use a generic OpenAI-compatible
 * mapping.
 */
export function createVideoGenerationProvider(
  config: AppConfig,
): VideoGenerationProvider {
  const genConfig = config.multimodal?.videoGeneration;
  if (!genConfig?.enabled || !genConfig?.modelRef) {
    return new NoOpVideoGenerationProvider();
  }

  const resolved = resolveImageGenConfig(
    genConfig.modelRef,
    (config as any).customProviders ?? [],
    (config as any).providerKeys ?? {},
  );

  if (!resolved) {
    return new NoOpVideoGenerationProvider();
  }

  // Auto-detect provider preset
  const preset = getVideoProviderPreset(resolved.provider);
  const providerConfig: OpenAIVideoGenConfig = {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    modelId: resolved.modelId,
  };

  if (preset?.responseMapping) {
    providerConfig.responseMapping = preset.responseMapping;
  }
  if (preset?.paramsMapping) {
    providerConfig.paramsMapping = preset.paramsMapping;
  }

  return new OpenAIVideoGenerationProvider(providerConfig);
}
