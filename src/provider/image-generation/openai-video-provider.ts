// ---------------------------------------------------------------------------
// OpenAI-compatible Video generation API provider
//
// Supports any OpenAI-compatible video generation API with configurable
// response field mapping for different providers (Agnes, Seedance via
// aggregators, etc.).
//
// Typical flow:
//   POST {endpointPath}  →  submit generation, get task_id
//   GET  {endpointPath}/{task_id}  →  poll until complete
//   Download video from resolved URL
// ---------------------------------------------------------------------------

import type {
  VideoGenerationProvider,
  VideoGenerationInput,
  VideoGenerationOutput,
} from '../../tools/builtins/multimodal/video-generation-provider.js';
import { fetchWithTimeout } from './fetch-utils.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Defines how to parse poll responses for different providers. */
export interface VideoResponseMapping {
  /** Dot-notation path to task ID in submit response. Default: "task_id". */
  taskIdField?: string;
  /** Dot-notation path to completion status. Default: "data.status". */
  statusField?: string;
  /** Status value meaning success. Default: "SUCCESS". */
  successValue?: string;
  /** Status values meaning failure. Default: ["FAILED", "ERROR"]. */
  failureValues?: string[];
  /**
   * Ordered dot-notation paths to find the video URL in a success response.
   * Default: ["data.data.remixed_from_video_id", "data.result_url"].
   */
  videoUrlPaths?: string[];
  /** Dot-notation path to progress percentage/number. Default: "data.progress". */
  progressField?: string;
  /** API endpoint path for submission. Default: "/v1/video/generations". */
  endpointPath?: string;
  /** If submit response wraps result in a field, unwrap it. */
  submitEnvelopeField?: string;
}

/** Maps internal field names to provider-specific API field names. */
export interface VideoParamsMapping {
  /** API field name for duration. Default: "seconds". */
  durationField?: string;
  /** API field name for resolution/size. Default: "size". */
  sizeField?: string;
  /** If set, add an aspect_ratio field using this API name. */
  aspectRatioField?: string;
}

export interface OpenAIVideoGenConfig {
  baseUrl: string;
  apiKey: string;
  /** Model ID to pass to the API (e.g. "agnes-video-v2.0"). */
  modelId: string;
  /** Request timeout in ms for each HTTP call. Default 300s. */
  timeoutMs?: number;
  /** Polling interval in ms. Default 5000. */
  pollIntervalMs?: number;
  /** Max wait time for video generation in ms. Default 600s (10 min). */
  maxWaitMs?: number;
  /** Custom response field mapping for non-standard providers. */
  responseMapping?: VideoResponseMapping;
  /** Custom parameter name mapping. */
  paramsMapping?: VideoParamsMapping;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 600_000;

const DEFAULT_RESPONSE_MAPPING: Required<VideoResponseMapping> = {
  taskIdField: 'task_id',
  statusField: 'data.status',
  successValue: 'SUCCESS',
  failureValues: ['FAILED', 'ERROR'],
  videoUrlPaths: ['data.data.remixed_from_video_id', 'data.result_url'],
  progressField: 'data.progress',
  endpointPath: '/v1/video/generations',
  submitEnvelopeField: '',
};

const DEFAULT_PARAMS_MAPPING: Required<VideoParamsMapping> = {
  durationField: 'seconds',
  sizeField: 'size',
  aspectRatioField: '',
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAIVideoGenerationProvider implements VideoGenerationProvider {
  private respMap: Required<VideoResponseMapping>;
  private paramMap: Required<VideoParamsMapping>;

  constructor(private config: OpenAIVideoGenConfig) {
    this.respMap = { ...DEFAULT_RESPONSE_MAPPING, ...config.responseMapping };
    this.paramMap = { ...DEFAULT_PARAMS_MAPPING, ...config.paramsMapping };
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const {
      baseUrl,
      apiKey,
      modelId,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      maxWaitMs = DEFAULT_MAX_WAIT_MS,
    } = this.config;

    // 1. Submit the generation request
    const submitUrl = this.buildUrl(baseUrl, this.respMap.endpointPath);
    const rawSubmit = await this.fetchJson(submitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(this.buildSubmitBody(input, modelId)),
      timeoutMs,
    });

    const submitResponse = this.respMap.submitEnvelopeField
      ? rawSubmit[this.respMap.submitEnvelopeField]
      : rawSubmit;

    const taskId = getByPath(submitResponse, this.respMap.taskIdField);
    if (!taskId) {
      throw new Error(
        `Video generation API did not return a task_id (path: ${this.respMap.taskIdField}) — ` +
        `response: ${JSON.stringify(submitResponse).slice(0, 500)}`,
      );
    }

    // 2. Poll for completion
    const statusUrl = `${submitUrl}/${taskId}`;
    const videoUrl = await this.pollForCompletion(statusUrl, apiKey, timeoutMs, pollIntervalMs, maxWaitMs);
    if (!videoUrl) {
      throw new Error(`Video generation timed out after ${maxWaitMs}ms. Task ID: ${taskId}`);
    }

    // 3. Download the video
    const videoBuffer = await this.downloadVideo(videoUrl, apiKey, timeoutMs);
    return {
      data: videoBuffer,
      mimeType: 'video/mp4',
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildSubmitBody(input: VideoGenerationInput, modelId: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      prompt: input.prompt,
      n: 1,
    };

    // Duration
    if (input.seconds) {
      body[this.paramMap.durationField] = input.seconds;
    }

    // Size / resolution
    if (input.size) {
      body[this.paramMap.sizeField] = input.size;
    }

    // Aspect ratio (Seedance-style)
    if (input.aspectRatio && this.paramMap.aspectRatioField) {
      body[this.paramMap.aspectRatioField] = input.aspectRatio;
    }

    // Seed
    if (input.seed !== undefined) {
      body['seed'] = input.seed;
    }

    // Reference images for image-to-video (Seedance-style)
    if (input.referenceImages && input.referenceImages.length > 0) {
      body['references'] = { images: input.referenceImages };
    }

    // Extra vendor-specific params
    if (input.extraParams) {
      Object.assign(body, input.extraParams);
    }

    return body;
  }

  private async pollForCompletion(
    statusUrl: string,
    apiKey: string,
    timeoutMs: number,
    pollIntervalMs: number,
    maxWaitMs: number,
  ): Promise<string | undefined> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const rawStatus = await this.fetchJson(statusUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs,
      });

      const status = getByPath(rawStatus, this.respMap.statusField);
      const progress = getByPath(rawStatus, this.respMap.progressField) ?? 0;

      // Check for failure
      if (this.respMap.failureValues.includes(String(status))) {
        throw new Error(`Video generation failed: ${JSON.stringify(rawStatus).slice(0, 1000)}`);
      }

      // Check for success
      if (status === this.respMap.successValue) {
        for (const path of this.respMap.videoUrlPaths) {
          const url = getByPath(rawStatus, path);
          if (url && typeof url === 'string') return url;
        }
        throw new Error(
          `Video generation succeeded but no video URL found at paths: ` +
          `${this.respMap.videoUrlPaths.join(', ')} — ${JSON.stringify(rawStatus).slice(0, 500)}`,
        );
      }

      // Still processing — wait and retry
      await sleep(pollIntervalMs);
    }

    return undefined;
  }

  private async downloadVideo(url: string, apiKey: string, timeoutMs: number): Promise<Buffer> {
    // Only send auth headers for API endpoint URLs, not external storage URLs
    const isApiUrl = url.includes(this.config.baseUrl.replace(/\/+$/, ''));
    const headers: Record<string, string> = {};
    if (isApiUrl) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(url, { headers, timeoutMs });
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR') {
        throw new Error(`Video download timed out after ${timeoutMs}ms`);
      }
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Video download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async fetchJson(url: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
    const { timeoutMs, ...fetchInit } = init;
    const response = await fetchWithTimeout(url, { ...fetchInit, timeoutMs });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      throw new Error(
        `Video API error: ${response.status} ${response.statusText} — ${errorBody.slice(0, 500)}`,
      );
    }

    return response.json();
  }

  private buildUrl(baseUrl: string, path: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    if (path.startsWith('/v1') && base.endsWith('/v1')) {
      return `${base}${path.slice(3)}`;
    }
    return `${base}${path}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a nested value from an object by dot-notation path. */
function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
