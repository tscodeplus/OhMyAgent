// ---------------------------------------------------------------------------
// v4 Image Generation Provider interface
// ---------------------------------------------------------------------------

export interface ImageGenerationInput {
  prompt: string;
  size: '1024x1024' | '1024x1536' | '1536x1024' | '2000x1000' | '1000x2000' | '2000x667' | '667x2000' | (string & {});
  modelRef: string;
  /** Quality level (provider-dependent). */
  quality?: 'low' | 'medium' | 'high' | 'auto' | (string & {});
  /** Output image format. */
  outputFormat?: 'png' | 'webp' | 'jpeg' | (string & {});
  /** Number of images to generate (provider-dependent, default 1). */
  n?: number;
  /** Thinking/reasoning level before rendering (GPT-Image-2 specific). */
  thinking?: 'off' | 'low' | 'medium' | 'high' | (string & {});
  /** Seed for reproducible results (provider-dependent). */
  seed?: number;
  /** Background handling (GPT-Image specific: "opaque"). */
  background?: 'auto' | 'opaque' | (string & {});
  /** Reference image URLs or data URIs for image-to-image generation. */
  referenceImages?: string[];
  /**
   * Extra provider-specific parameters passed through to the API body.
   * Use for vendor-specific fields not covered by the standard interface.
   */
  extraParams?: Record<string, unknown>;
}

export interface ImageGenerationOutput {
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | (string & {});
}

export interface ImageGenerationProvider {
  generate(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
}

export class NoOpImageGenerationProvider implements ImageGenerationProvider {
  async generate(): Promise<ImageGenerationOutput> {
    throw new Error('Image generation provider not configured');
  }
}
