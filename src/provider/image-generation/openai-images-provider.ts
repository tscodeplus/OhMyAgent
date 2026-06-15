// ---------------------------------------------------------------------------
// OpenAI-compatible Images API provider for image generation
//
// Supports any OpenAI Images API-compatible endpoint (e.g. Agnes Image,
// DALL-E, etc.) that implements POST /v1/images/generations.
// ---------------------------------------------------------------------------

import type {
  ImageGenerationProvider,
  ImageGenerationInput,
  ImageGenerationOutput,
} from '../../tools/builtins/multimodal/image-generation-provider.js';
import { fetchWithTimeout, setByPath } from './fetch-utils.js';

/** Maps internal field names to provider-specific API field names. */
export interface ImageParamsMapping {
  /** Dot-notation path for reference images array. Default: "references.images". */
  referenceImagesField?: string;
  /** How to format reference images: "array" (default) or "first" (single URL). */
  referenceImagesMode?: 'array' | 'first';
}

export interface OpenAIImageGenConfig {
  baseUrl: string;
  apiKey: string;
  /** Model ID to pass to the API (e.g. "agnes-image-2.1-flash"). */
  modelId: string;
  /** Request timeout in milliseconds. Default 120s. */
  timeoutMs?: number;
  /** Custom parameter name mapping. */
  paramsMapping?: ImageParamsMapping;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_PARAMS_MAPPING: Required<ImageParamsMapping> = {
  referenceImagesField: 'references.images',
  referenceImagesMode: 'array' as const,
};

interface OpenAIImageResponse {
  data: Array<{
    url?: string;
    b64_json?: string;
  }>;
}

export class OpenAIImageGenerationProvider implements ImageGenerationProvider {
  private paramMap: Required<ImageParamsMapping>;

  constructor(private config: OpenAIImageGenConfig) {
    this.paramMap = { ...DEFAULT_PARAMS_MAPPING, ...config.paramsMapping };
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const { baseUrl, apiKey, modelId, timeoutMs = DEFAULT_TIMEOUT_MS } = this.config;

    const url = this.buildUrl(baseUrl, '/v1/images/generations');

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(input, modelId)),
        timeoutMs,
      });
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR') {
        throw new Error(`Image generation API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      throw new Error(
        `Image generation API error: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    const result = (await response.json()) as OpenAIImageResponse;
    const imageData = result.data?.[0];
    if (!imageData) {
      throw new Error('Image generation API returned no data');
    }

    const mimeType = this.resolveMimeType(input.outputFormat);

    // Handle base64-encoded image
    if (imageData.b64_json) {
      return {
        data: Buffer.from(imageData.b64_json, 'base64'),
        mimeType,
      };
    }

    // Handle URL-returned image — download it
    if (imageData.url) {
      const imageBuffer = await this.downloadImage(imageData.url, timeoutMs);
      return {
        data: imageBuffer,
        mimeType,
      };
    }

    throw new Error('Image generation API returned neither URL nor base64 data');
  }

  private async downloadImage(url: string, timeoutMs: number): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, { timeoutMs });
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR') {
        throw new Error(`Image download timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Image download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private resolveMimeType(outputFormat?: string): 'image/png' | 'image/jpeg' | 'image/webp' {
    switch (outputFormat) {
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      default: return 'image/png';
    }
  }

  /** Build API request body, merging standard + extra params. */
  private buildRequestBody(input: ImageGenerationInput, modelId: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      prompt: input.prompt,
      n: input.n ?? 1,
      size: input.size,
    };

    if (input.quality) body['quality'] = input.quality;
    if (input.outputFormat) {
      body['output_format'] = input.outputFormat;
      // Also request b64_json for non-png formats, since URL mime may be unreliable
      if (input.outputFormat !== 'png') {
        body['response_format'] = 'b64_json';
      }
    }
    if (input.thinking) body['thinking'] = input.thinking;
    if (input.seed !== undefined) body['seed'] = input.seed;
    if (input.background) body['background'] = input.background;

    // Reference images for image-to-image generation
    if (input.referenceImages && input.referenceImages.length > 0) {
      const value = this.paramMap.referenceImagesMode === 'first'
        ? input.referenceImages[0]
        : input.referenceImages;
      setByPath(body, this.paramMap.referenceImagesField, value);
    }

    // Merge extraParams (vendor-specific fields)
    if (input.extraParams) {
      Object.assign(body, input.extraParams);
    }

    return body;
  }

  private buildUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    if (path.startsWith('/v1') && base.endsWith('/v1')) {
      return `${base}${path.slice(3)}`;
    }
    return `${base}${path}`;
  }
}

/**
 * Resolve provider config from AppConfig's custom_providers / provider_keys.
 *
 * `modelRef` format: "provider/model-id" (e.g. "agnes/agnes-image-2.1-flash")
 * or just "model-id" (uses the first matching custom provider).
 */
export function resolveImageGenConfig(
  modelRef: string,
  customProviders: Array<{
    provider: string;
    apiKey: string;
    baseUrl: string;
  }>,
  providerKeys: Record<string, { apiKey?: string; baseUrl?: string }>,
): { provider: string; modelId: string; apiKey: string; baseUrl: string } | null {
  const parts = modelRef.split('/');
  let providerName: string;
  let modelId: string;

  if (parts.length >= 2) {
    providerName = parts[0];
    modelId = parts.slice(1).join('/');
  } else {
    // No provider prefix — try to infer from available providers
    modelId = parts[0];
    providerName = '';
    // Search custom providers for one whose models include this model ID
    for (const cp of customProviders) {
      providerName = cp.provider;
      break; // Use the first custom provider as default
    }
  }

  // Look up in custom_providers first
  const customProvider = customProviders.find((cp) => cp.provider === providerName);
  if (customProvider) {
    return {
      provider: providerName,
      modelId,
      apiKey: customProvider.apiKey,
      baseUrl: customProvider.baseUrl,
    };
  }

  // Fall back to provider_keys
  const pk = providerKeys[providerName];
  if (pk?.apiKey && pk?.baseUrl) {
    return {
      provider: providerName,
      modelId,
      apiKey: pk.apiKey,
      baseUrl: pk.baseUrl,
    };
  }

  return null;
}
