import type { ImageContent, Model, Message, TextContent } from '../pi-mono/ai/types.js';
import type { VisionBridgeConfig, VisionCapabilities } from './vision-bridge-types.js';
import { VISION_BRIDGE_FAILED_PLACEHOLDER } from './vision-bridge-types.js';
import type { CustomProviderConfig } from '../app/types.js';
import { resolveVisionModel } from './vision-bridge-config.js';
import type { Logger } from 'pino';
import { VisionBridgeCache } from './vision-bridge-cache.js';
import {
  extractJsonObject,
  formatStructuredVisionNote,
  formatInvalidStructuredNote,
  formatSimpleVisionNote,
  getVisionCapabilities,
} from './vision-primitives.js';
import { buildNotePrompt, buildPrimitivePrompt } from './vision-bridge-prompts.js';
import { i18n } from '../i18n/index.js';
import { streamSimple } from '@earendil-works/pi-ai';
import { createHash } from 'node:crypto';

// ─── Cache Key ───

function imageCacheKey(
  image: ImageContent,
  userRequest: string,
  modelSignature: string,
): string {
  const hash = createHash('sha256');
  hash.update(String(image.type));
  if ('data' in image) hash.update(String(image.data));
  if ('url' in image) hash.update(String(image.url));
  if ('mimeType' in image) hash.update(String(image.mimeType ?? ''));
  hash.update(userRequest);
  hash.update(modelSignature);
  return hash.digest('hex');
}

function modelSignature(model: Model<any>, capabilities: VisionCapabilities | null): string {
  return `${model.provider}/${model.id}:${capabilities?.outputFormat ?? 'note'}`;
}

// ─── Helpers ───

/**
 * Create a copy of the model with a custom base URL.
 * The model object from the registry is immutable-like (satisfies TypedSchema),
 * so we create a shallow copy with the overridden base URL.
 */
function withBaseUrl(model: Model<any>, baseUrl: string): Model<any> {
  return { ...model, baseUrl };
}

/**
 * Build a user message with the image and analysis prompt.
 */
function buildImageMessage(image: ImageContent, promptText: string): Message {
  const content: (ImageContent | TextContent)[] = [
    { type: 'image', data: image.data, mimeType: image.mimeType },
    { type: 'text', text: promptText },
  ];

  return {
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

// ─── Service ───

export class VisionBridgeService {
  private cache: VisionBridgeCache;
  private logger: Logger;

  constructor(
    private config: VisionBridgeConfig,
    private customProviders: CustomProviderConfig[],
    logger?: Logger,
  ) {
    this.cache = new VisionBridgeCache(config.maxCacheEntries);
    this.logger = logger ?? { info: (..._args: any[]) => {}, warn: (..._args: any[]) => {}, error: (..._args: any[]) => {} } as unknown as Logger;
  }

  /**
   * Process images through the vision bridge.
   * If the target model doesn't support images, analyzes them with a vision model
   * and injects text descriptions into the input.
   *
   * @returns Modified input text and whether the bridge was used.
   */
  async bridge(
    input: string,
    images: ImageContent[],
    targetModel: Model<any>,
    opts?: { forceBridge?: boolean },
  ): Promise<{ text: string; usedBridge: boolean }> {
    if (!images.length) return { text: input, usedBridge: false };

    const modelHasVision = targetModel.input?.includes('image');
    this.logger.info({
      imageCount: images.length,
      modelId: targetModel.id,
      modelInput: targetModel.input,
      modelHasVision,
      forceBridge: opts?.forceBridge ?? false,
    }, 'VisionBridge: bridge() called');

    // When bridge is explicitly configured and enabled by the user,
    // it takes priority over model's declared image capabilities.
    // A model claiming image support doesn't mean it handles them well.
    if (modelHasVision && !opts?.forceBridge) {
      this.logger.debug('VisionBridge: SKIP - model supports native vision, bridge not forced');
      return { text: input, usedBridge: false };
    }

    this.logger.info('VisionBridge: START - resolving vision model...');

    try {
      const resolved = resolveVisionModel(this.config, this.customProviders);
      this.logger.info({
        provider: resolved.model.provider,
        modelId: resolved.model.id,
        hasCapabilities: getVisionCapabilities(resolved.model) !== null,
      }, 'VisionBridge: vision model resolved');

      const visionModel = withBaseUrl(resolved.model, resolved.baseUrl);
      const capabilities = getVisionCapabilities(resolved.model);
      const sig = modelSignature(resolved.model, capabilities);

      const notes: string[] = [];

      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        try {
          const key = imageCacheKey(image, input, sig);
          const cached = this.cache.get(key);
          if (cached) {
            this.logger.debug({ imageIndex: i }, 'VisionBridge: cache hit');
            notes.push(cached);
            continue;
          }

          this.logger.debug({ imageIndex: i }, 'VisionBridge: calling vision model');
          const t0 = Date.now();
          const note = capabilities
            ? await this.analyzeWithPrimitives(visionModel, resolved.apiKey, image, input, capabilities)
            : await this.analyzeAsNote(visionModel, resolved.apiKey, image, input);
          this.logger.debug({ imageIndex: i, durationMs: Date.now() - t0, noteLen: note.length }, 'VisionBridge: analysis done');

          this.cache.set(key, note);
          notes.push(note);
        } catch (err) {
          this.logger.error({ imageIndex: i, err }, 'VisionBridge: analysis FAILED');
          notes.push(VISION_BRIDGE_FAILED_PLACEHOLDER);
        }
      }

      const visionContext = notes.join('\n\n');
      const prefix = [
        '[System Note] The user sent an image that has been pre-analyzed by a vision model.',
        'Below is the structured analysis result. Answer the user\'s question directly based on this information.',
        'Do NOT attempt to use any tools (file_read, file_search, shell, Python, etc.) to find or analyze the image file — analysis is complete and the original image is inaccessible.',
      ].join(' ');

      const text = `${prefix}\n\n${visionContext}\n\n${input}`;
      this.logger.info({ contextLen: visionContext.length, totalLen: text.length }, 'VisionBridge: DONE');
      return { text, usedBridge: true };
    } catch (err) {
      this.logger.error({err}, 'VisionBridge: FAILED to resolve/analyze');
      return { text: input, usedBridge: false };
    }
  }

  // ─── Analysis: Simple Note ───

  private async analyzeAsNote(
    model: Model<any>,
    apiKey: string,
    image: ImageContent,
    userRequest: string,
  ): Promise<string> {
    const prompt = buildNotePrompt(userRequest);
    const message = buildImageMessage(image, prompt);

    const response = await streamSimple(
      model,
      {
        systemPrompt: i18n.t('prompts:vision.systemNote'),
        messages: [message],
        tools: [],
      },
      {
        apiKey,
        maxTokens: 900,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );

    let text = '';
    for await (const event of response) {
      if (event.type === 'text_delta') {
        text += event.delta;
      }
    }

    const trimmed = text.trim();
    if (trimmed.length > this.config.maxNoteChars) {
      return formatSimpleVisionNote(trimmed.slice(0, this.config.maxNoteChars) + '\n\n[truncated]');
    }
    return formatSimpleVisionNote(trimmed);
  }

  // ─── Analysis: Structured with Primitives ───

  private async analyzeWithPrimitives(
    model: Model<any>,
    apiKey: string,
    image: ImageContent,
    userRequest: string,
    capabilities: VisionCapabilities,
  ): Promise<string> {
    const prompt = buildPrimitivePrompt(userRequest, capabilities);
    const message = buildImageMessage(image, prompt);

    const response = await streamSimple(
      model,
      {
        systemPrompt: i18n.t('prompts:vision.systemJson'),
        messages: [message],
        tools: [],
      },
      {
        apiKey,
        maxTokens: 1100,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );

    let text = '';
    for await (const event of response) {
      if (event.type === 'text_delta') {
        text += event.delta;
      }
    }

    const parsed = extractJsonObject(text.trim());
    if (!parsed) {
      return formatInvalidStructuredNote(text.trim());
    }

    return formatStructuredVisionNote(parsed, capabilities);
  }
}
