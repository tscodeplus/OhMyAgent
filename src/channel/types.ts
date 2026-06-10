export interface MediaResource {
  url: string;
  type: 'image' | 'file' | 'audio' | 'video';
  name?: string;
  size?: number;
}

export interface CardData {
  schema: string;
  config?: Record<string, unknown>;
  header?: Record<string, unknown>;
  body?: Record<string, unknown>;
  elements?: Record<string, unknown>[];
}

export interface ChannelContext {
  channelId: string;
  channelType: string;
  message: MessageEnvelope;
}

export interface MessageEnvelope {
  id: string;
  text: string;
  senderId: string;
  threadId?: string;
  media?: MediaResource[];
  raw: unknown;
  replyMeta?: Record<string, unknown>;
}

export interface ReplyContent {
  text?: string;
  cards?: CardData[];
  media?: MediaResource[];
}

export interface ChannelAdapter {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onReceive(handler: (ctx: ChannelContext) => Promise<void>): void;
  sendReply(ctx: ChannelContext, reply: ReplyContent): Promise<void>;
}
