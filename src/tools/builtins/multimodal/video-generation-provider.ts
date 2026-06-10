// ---------------------------------------------------------------------------
// v4 Video Generation Provider interface
// ---------------------------------------------------------------------------

export interface VideoGenerationInput {
  prompt: string;
  /** Video duration in seconds (e.g. "5.0"). Provider-dependent field name. */
  seconds?: string;
  /** Resolution (e.g. "1280x768"). Provider-dependent field name. */
  size?: string;
  /** Aspect ratio (e.g. "16:9", "9:16"). Seedance-style providers. */
  aspectRatio?: string;
  /** Seed for reproducible results (provider-dependent). */
  seed?: number;
  /** Reference image URLs for image-to-video generation. */
  referenceImages?: string[];
  modelRef: string;
  /**
   * Extra provider-specific parameters passed through to the API body.
   * Use for vendor-specific fields not covered by the standard interface.
   */
  extraParams?: Record<string, unknown>;
}

export interface VideoGenerationOutput {
  data: Buffer;
  mimeType: 'video/mp4';
}

export interface VideoGenerationProvider {
  generate(input: VideoGenerationInput): Promise<VideoGenerationOutput>;
}

export class NoOpVideoGenerationProvider implements VideoGenerationProvider {
  async generate(): Promise<VideoGenerationOutput> {
    throw new Error('Video generation provider not configured');
  }
}
