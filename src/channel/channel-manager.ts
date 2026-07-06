import type { ChannelAdapter, ChannelContext, ReplyContent } from './types.js';

type MessageHandler = (ctx: ChannelContext, reply: (content: ReplyContent) => Promise<void>) => Promise<void>;

export class ChannelManager {
  private channels = new Map<string, ChannelAdapter>();
  private handler: MessageHandler | null = null;
  private logger?: { error: (...args: any[]) => void };

  setLogger(logger: { error: (...args: any[]) => void }): void {
    this.logger = logger;
  }

  register(adapter: ChannelAdapter): void {
    this.channels.set(adapter.id, adapter);
    // Wire up the global message handler if one is set
    if (this.handler) {
      adapter.onReceive(async (ctx) => {
        await this.handler!(ctx, (reply) => adapter.sendReply(ctx, reply));
      });
    }
  }

  unregister(id: string): void {
    this.channels.delete(id);
  }

  list(): ChannelAdapter[] {
    return Array.from(this.channels.values());
  }

  getByType(channelType: string): ChannelAdapter | undefined {
    for (const channel of this.channels.values()) {
      if (channel.id === channelType) return channel;
    }
    return undefined;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
    // Wire up all already-registered channels
    for (const adapter of this.channels.values()) {
      adapter.onReceive(async (ctx) => {
        await handler(ctx, (reply) => adapter.sendReply(ctx, reply));
      });
    }
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        await channel.start();
      })
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        // Log but don't crash — one channel failing shouldn't stop others
        this.logger?.error('Channel start failed:', result.reason);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try { await channel.stop(); } catch {}
      })
    );
  }
}
