/**
 * MessageHandler — processes incoming Feishu messages.
 *
 * Enqueues each message into the per-session ChatQueue and delegates
 * execution to AgentService. Creates a ReplyDispatcher for streaming
 * card updates during agent execution.
 *
 * For messages containing images (image type or post with img elements),
 * downloads the image from Feishu and passes it as ImageContent to the
 * agent for multimodal processing.
 *
 * v4 Phase 4: When an AttachmentResolver and AttachmentStore are configured,
 * all media resources (image, file, audio, video) are routed through the
 * unified multimodal pipeline:
 *   resolver.resolveFromChannel() → store.ingest() → security.validate()
 * Images passing validation are converted to ImageContent for the agent;
 * non-image resources generate a text description appended to the input.
 * Falls back to the original behavior when the pipeline is unavailable.
 *
 * v5 P2: Audio messages in private chats (or when @mentioned in groups) are
 * automatically transcribed via the configured STT provider before the agent
 * sees them.
 */

import type { ChatQueue } from './chat-queue.js';
import type { FeishuMessageContext } from './feishu-context.js';
import type { ImageContent } from '../../src/pi-mono/ai/types.js';
import type { AttachmentResolver } from '../../src/multimodal/attachments/attachment-resolver.js';
import type { AttachmentStore } from '../../src/multimodal/attachments/attachment-store.js';
import type { AttachmentSecurity } from '../../src/multimodal/attachments/attachment-security.js';
import type { MultimodalRuntimeConfig } from '../../src/multimodal/types.js';
import type { FeishuClient } from './feishu-client.js';
import { handleCommand } from '../../src/commands/command-handler.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import { createFeishuMediaTool, createFeishuDownloadTool } from './feishu-media-tool.js';
import { i18n } from '../../src/i18n/index.js';
import { imageBufferToImageContent } from './feishu-media.js';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MessageHandlerOptions {
  agentService: {
    execute(
      input: string,
      options?: {
        sessionId?: string;
        chatId?: string;
        messageId?: string;
        images?: ImageContent[];
        extraTools?: any[];
        channel?: string;
      },
    ): Promise<any>;
  };
  chatQueue: ChatQueue;
  /** Feishu client for media upload/send (used to create feishu_send_media tool). */
  feishuClient?: FeishuClient;
  /** Allowed directory roots for media tool file reading. */
  mediaAllowedRoots?: string[];
  /** Denied file patterns for media tool. */
  mediaDeniedPatterns?: string[];
  /** Optional client for downloading message media. */
  mediaDownloader?: {
    downloadResource(
      messageId: string,
      fileKey: string,
      type: 'image' | 'file',
    ): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }>;
  };
  logger?: {
    warn: (msg: string) => void;
  };

  // ── Command routing (self-contained, like Telegram/QQ/WeChat) ──
  commandDeps: CommandDeps;
  sendTextReply: (chatId: string, text: string) => Promise<void>;
  addReaction?: (messageId: string, type: string) => Promise<string | null>;
  removeReaction?: (messageId: string, reactionId: string) => Promise<void>;

  // -------------------------------------------------------------------------
  // v4 Phase 4: Multimodal runtime integration (optional)
  // When configured, all media resources are routed through the unified
  // attachment pipeline. When absent, the original per-type handling is used.
  // -------------------------------------------------------------------------
  attachmentResolver?: AttachmentResolver;
  attachmentStore?: AttachmentStore;
  attachmentSecurity?: AttachmentSecurity;
  multimodalConfig?: MultimodalRuntimeConfig;

  // -------------------------------------------------------------------------
  // v5 P2: Auto-transcription for audio messages (optional)
  // When configured, audio messages in private chats (or @mentioned in groups)
  // are automatically transcribed before the agent sees them.
  // -------------------------------------------------------------------------
  /** Lazy factory — STT providers are only created on first audio message. */
  getSttTranscriber?: () => ((audioPath: string, language?: string) => Promise<string>) | undefined;
  /** STT config for auto-transcription control. */
  sttConfig?: { autoTranscribe?: boolean; enabled?: boolean; language?: string };
  /** Bot's app_id used to detect @mentions in groups (format: @_bot_<app_id>). */
  botAppId?: string;
}

export class MessageHandler {
  constructor(private options: MessageHandlerOptions) {}

  /** Resolve STT transcriber lazily — only created on first audio message. */
  private _sttTranscriber: ((path: string, lang?: string) => Promise<string>) | undefined | null;
  private resolveSttTranscriber(): ((path: string, lang?: string) => Promise<string>) | undefined {
    if (this._sttTranscriber === undefined) {
      this._sttTranscriber = this.options.getSttTranscriber?.() ?? null;
    }
    return this._sttTranscriber || undefined;
  }

  private createMediaTool(chatId: string): any | null {
    const { feishuClient, mediaAllowedRoots, mediaDeniedPatterns } = this.options;
    if (!feishuClient?.uploadImage || !feishuClient?.uploadFile || !feishuClient?.sendMessage) {
      return null;
    }
    try {
      return createFeishuMediaTool({
        feishuClient,
        chatId,
        allowedRoots: mediaAllowedRoots,
        deniedPatterns: mediaDeniedPatterns,
      });
    } catch {
      return null;
    }
  }

  /**
   * Handle an incoming message.
   *
   * Slash commands are handled synchronously (no queue). Non-command messages
   * steer the running agent if active, otherwise enqueue for execution.
   *
   * Agent execution pipeline (inside the enqueued task):
   * 0. If v4 multimodal runtime is configured (attachmentResolver + attachmentStore):
   *    → route ALL resources through the unified pipeline
   * 1. If the message has image resources → download and pass to agent with text
   * 2. If the message is a non-text media type (file/audio/video/sticker) → describe as text
   * 3. Otherwise → pass extracted text to agent
   */
  async handle(context: FeishuMessageContext): Promise<boolean> {
    const text = context.text.trim();

    // ── Slash command routing ──
    if (text.startsWith('/')) {
      // /steer: swap to a new card before injecting the steer message
      const isSteer = /^\/steer(?:\s|$)/.test(text);
      if (isSteer) {
        const args = text.split(/\s+/).slice(1).join(' ');
        if (args && this.options.commandDeps.agentService.isRunning(context.sessionKey)) {
          // swapCard is async but the agent is still blocked on the pending
          // approval at this point — handleCommand → handleSteer will call
          // steer() which does clear → steer → reject synchronously AFTER
          await this.options.commandDeps.agentService.swapCard(context.sessionKey, context.messageId);
        }
      }

      const result = await handleCommand(
        text,
        context.sessionKey,
        this.options.commandDeps,
        context.messageId,
        context.chatId,
      );

      if (result) {
        if (result.reply) {
          await this.options.sendTextReply(context.chatId, result.reply);
        }
        if (result.forwardText) {
          this.enqueueAgentExecution(result.forwardText, context);
        }
        return true;
      }
      // Unrecognized command — fall through to agent execution
    }

    // ── Normal message → check pending question first, then steer or execute ──
    if (this.options.commandDeps.agentService.isRunning(context.sessionKey)) {
      // Check for pending user question (ask_user_question tool).
      // If the agent is waiting for an answer, route this message
      // as the answer instead of steering.
      const resolved = this.options.commandDeps.agentService.resolveFirstPendingQuestion(
        context.sessionKey,
        text,
      );
      if (resolved) {
        // The question card is updated to "✅ 回答已收到" via closeQuestion() —
        // no need for an extra text reply.
        return true;
      }

      // No pending question — normal steer
      // Steer MUST happen before swapCard: steer() synchronously rejects
      // pending approvals and queues the new message. swapCard() is async
      // (Feishu API calls) — if reject ran before steer, the agent loop
      // would resume during the await and find an empty steering queue.
      this.options.commandDeps.agentService.steer(context.sessionKey, text);
      await this.options.commandDeps.agentService.swapCard(context.sessionKey, context.messageId);
      return true;
    }
    this.enqueueAgentExecution(text, context);
    return false;
  }

  /** Enqueue agent execution with the full media-processing pipeline. */
  private enqueueAgentExecution(
    text: string,
    context: FeishuMessageContext,
  ): void {
    this.options.chatQueue.enqueue(context.sessionKey, async () => {
      const mediaTool = this.createMediaTool(context.chatId);
      const baseOptions = {
        sessionId: context.sessionKey,
        chatId: context.chatId,
        messageId: context.messageId,
        channel: 'feishu' as const,
        extraTools: mediaTool ? [mediaTool] : [],
      };

      // ── v4 Phase 4: Multimodal pipeline (when configured) ──
      if (this.options.attachmentResolver && this.options.attachmentStore && context.resources.length > 0) {
        await this.processWithMultimodalPipeline(text, context, baseOptions);
        return;
      }

      // ── Legacy fallback: per-type handling ──

      // Messages with image resources: download and pass as multimodal input
      const imageResources = context.resources.filter((r) => r.type === 'image');
      if (imageResources.length > 0) {
        const images = await this.downloadImageResources(
          context.messageId,
          imageResources,
        );
        const input = text || i18n.t('messages:media.imageSent');
        await this.options.agentService.execute(input, { ...baseOptions, images });
        return;
      }

      // Standalone file message
      // On-demand download: tell the agent about the file and inject a
      // download tool so the agent can decide whether to fetch the content.
      if (context.messageType === 'file' && context.resources.length > 0) {
        const fileInfos = context.resources.map((r, i) => {
          const name = r.fileName || 'unknown';
          const key = r.fileKey || '';
          return `  ${i + 1}. ${name}${key ? ` (file_key: ${key})` : ''}`;
        }).join('\n');

        // Create download tool scoped to this message
        let downloadTool: any = null;
        if (this.options.feishuClient) {
          try {
            downloadTool = createFeishuDownloadTool({
              feishuClient: this.options.feishuClient,
              messageId: context.messageId,
            });
          } catch { /* tool creation failed — agent can still use generic download_file */ }
        }

        const extraTools = [...baseOptions.extraTools];
        if (downloadTool) extraTools.push(downloadTool);

        const input =
          `📎 收到文件附件：\n${fileInfos}\n\n` +
          (downloadTool
            ? `如需读取文件内容，请使用 download_feishu_file 工具并传入对应的 file_key 进行下载。`
            : `你当前无法直接读取此文件的内容。`);

        await this.options.agentService.execute(input, {
          ...baseOptions,
          extraTools,
        });
        return;
      }

      // Standalone audio message
      if (context.messageType === 'audio' && context.resources.length > 0) {
        // v5 P2: Attempt auto-transcription when conditions are met
        let input: string;
        if (this.shouldAutoTranscribe(context)) {
          const transcribed = await this.transcribeAudioFromFeishu(
            context.messageId,
            context.resources[0].fileKey,
          );
          if (transcribed) {
            input = transcribed;
          } else {
            input = this.audioPlaceholderText(context);
          }
        } else {
          input = this.audioPlaceholderText(context);
        }
        await this.options.agentService.execute(input, baseOptions);
        return;
      }

      // Standalone video/media message
      if (context.messageType === 'media' && context.resources.length > 0) {
        const fileName = context.resources[0]?.fileName || '';
        await this.options.agentService.execute(i18n.t('messages:media.videoSent', { name: fileName }), baseOptions);
        return;
      }

      // Standalone sticker message
      if (context.messageType === 'sticker' && context.resources.length > 0) {
        await this.options.agentService.execute(i18n.t('messages:media.stickerSent'), baseOptions);
        return;
      }

      // Text / post (without images) / fallback
      await this.options.agentService.execute(text, baseOptions);
    });
  }

  /**
   * Process all media resources through the unified multimodal pipeline:
   *   resolver.resolveFromChannel() → store.ingest() → security.validate()
   *
   * Images that pass validation are converted to ImageContent.
   * Non-image resources generate a text description appended to the input.
   */
  private async processWithMultimodalPipeline(
    text: string,
    context: FeishuMessageContext,
    baseOptions: { sessionId: string; chatId: string; messageId: string; channel: 'feishu' },
  ): Promise<void> {
    const resolver = this.options.attachmentResolver!;
    const store = this.options.attachmentStore!;
    const security = this.options.attachmentSecurity;

    const images: ImageContent[] = [];
    const descriptions: string[] = [];

    for (const resource of context.resources) {
      try {
        // Step 1: Resolve channel resource to ingest input
        const ingestInput = await resolver.resolveFromChannel(
          {
            url: resource.fileKey,
            type: resource.type === 'sticker' ? 'image' : resource.type === 'video' ? 'file' : resource.type,
            name: resource.fileName,
            size: resource.duration,
          },
          context.sessionKey,
          context.messageId,
        );

        // Step 2: Store the attachment
        const record = await store.ingest(ingestInput);

        // Step 3: Validate (optional)
        if (security) {
          const check = security.validate(record);
          if (!check.passed) {
            descriptions.push(`[附件被安全策略拦截: ${resource.fileKey} - ${check.reason}]`);
            continue;
          }
        }

        // Step 4: Route by type
        if (resource.type === 'image' || resource.type === 'sticker') {
          // Read the stored file and convert to ImageContent. Async read: a
          // sync readFileSync here blocks the single event loop while a large
          // image is pulled off disk, stalling every other in-flight message.
          const fs = await import('node:fs/promises');
          const buffer = await fs.readFile(record.localPath);
          images.push(imageBufferToImageContent(buffer));
        } else if (resource.type === 'audio' && this.shouldAutoTranscribe(context)) {
          // v5 P2: Auto-transcribe audio from already-stored local file
          const transcribed = await this.transcribeAudioFromPath(record.localPath);
          if (transcribed) {
            descriptions.push(`[语音转写]\n${transcribed}`);
          } else {
            const name = resource.fileName || resource.fileKey;
            descriptions.push(`[已接收音频: ${name}, 已缓存至: ${record.localPath}]`);
          }
        } else {
          // Non-image non-audio (or audio w/o auto-transcribe): generate description
          const typeLabel = resource.type === 'file' ? '文件' : resource.type === 'audio' ? '音频' : '视频';
          const name = resource.fileName || resource.fileKey;
          descriptions.push(
            `📎 已接收${typeLabel}: ${name}\n` +
            `   本地路径: ${record.localPath}\n` +
            `   可使用 file_read 工具读取此文件的内容。`
          );
        }
      } catch (err) {
        this.options.logger?.warn(`Failed to process resource ${resource.fileKey} via multimodal pipeline: ${err}`);
        // Fallback description for failed resources
        descriptions.push(`[附件处理失败: ${resource.fileName || resource.fileKey}]`);
      }
    }

    // Build the final input: original text + non-image descriptions
    const descSuffix = descriptions.length > 0 ? '\n' + descriptions.join('\n') : '';
    const input = (text || i18n.t('messages:media.imageSent')) + descSuffix;

    await this.options.agentService.execute(input, {
      ...baseOptions,
      images: images.length > 0 ? images : undefined,
    });
  }

  /**
   * Determine whether auto-transcription should be attempted for the given context.
   *
   * Triggers when ALL of:
   *   1. STT is enabled in config (sttConfig.enabled)
   *   2. Auto-transcribe is enabled (sttConfig.autoTranscribe)
   *   3. A transcriber function is provided
   *   4. The message is a private chat OR the bot is @mentioned in a group
   */
  private shouldAutoTranscribe(context: FeishuMessageContext): boolean {
    const sttCfg = this.options.sttConfig;
    if (!sttCfg?.enabled || sttCfg.autoTranscribe === false) return false;
    if (!this.resolveSttTranscriber()) return false;

    // Private chat — always transcribe
    if (context.chatType === 'p2p') return true;

    // Group chat — only transcribe if @mentioned
    if (context.chatType === 'group' && this.options.botAppId) {
      const rawMentions: Array<{ key?: string; id?: { open_id?: string } }> | undefined =
        context.rawEvent?.event?.message?.mentions;
      const botMentionKey = `@_bot_${this.options.botAppId}`;
      if (rawMentions?.length) {
        return rawMentions.some(
          (m) => m.key === botMentionKey || m.id?.open_id === botMentionKey,
        );
      }
    }

    return false;
  }

  /**
   * Build the placeholder text for an audio message when transcription is not
   * available or fails.
   */
  private audioPlaceholderText(context: FeishuMessageContext): string {
    const durationMs = context.resources[0]?.duration;
    const durationSec = durationMs ? Math.round(durationMs / 1000) : 0;
    return i18n.t('messages:media.audioSent', { duration: durationSec });
  }

  /**
   * Transcribe audio from a local file path. Returns the transcribed text,
   * or null if transcription failed or no transcriber is configured.
   */
  private async transcribeAudioFromPath(audioPath: string): Promise<string | null> {
    if (!this.resolveSttTranscriber()) return null;
    try {
      const text = await this.resolveSttTranscriber()!(
        audioPath,
        this.options.sttConfig?.language ?? 'auto',
      );
      return text.trim() || null;
    } catch (err) {
      this.options.logger?.warn(`Audio transcription failed for ${audioPath}: ${err}`);
      return null;
    }
  }

  /**
   * Download an audio resource from Feishu, write to a temp file, transcribe it,
   * and clean up. Returns the transcribed text, or null on failure.
   */
  private async transcribeAudioFromFeishu(
    messageId: string,
    fileKey: string,
  ): Promise<string | null> {
    if (!this.options.mediaDownloader || !this.resolveSttTranscriber()) return null;

    try {
      const { buffer } = await this.options.mediaDownloader.downloadResource(
        messageId,
        fileKey,
        'file',
      );
      const tmpPath = join(tmpdir(), `feishu-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`);
      await writeFile(tmpPath, buffer);
      try {
        return await this.transcribeAudioFromPath(tmpPath);
      } finally {
        try { await unlink(tmpPath); } catch { /* best-effort cleanup */ }
      }
    } catch (err) {
      this.options.logger?.warn(`Audio download/transcription failed for ${fileKey}: ${err}`);
      return null;
    }
  }

  /**
   * Download image resources and convert to ImageContent array.
   */
  private async downloadImageResources(
    messageId: string,
    resources: Array<{ type: string; fileKey: string }>,
  ): Promise<ImageContent[]> {
    if (!this.options.mediaDownloader) return [];

    const results: ImageContent[] = [];
    for (const resource of resources) {
      try {
        const { buffer } = await this.options.mediaDownloader.downloadResource(
          messageId,
          resource.fileKey,
          'image',
        );
        results.push(imageBufferToImageContent(buffer));
      } catch (err) {
        // Log but continue — don't fail the whole message for one image
        this.options.logger?.warn(`Failed to download image ${resource.fileKey}: ${err}`);
      }
    }
    return results;
  }
}
