// ---------------------------------------------------------------------------
// v4 Multimodal Runtime — core type definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  messageId: string;
  originalUrl: string;
  localPath: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  parsed: boolean;
  parseResult?: MediaParseResult;
  createdAt: number;
}

export interface AttachmentSecurityCheck {
  passed: boolean;
  reason?: string;
  resolvedPath: string;
}

// ---------------------------------------------------------------------------
// Media parsing
// ---------------------------------------------------------------------------

export interface MediaParseResult {
  kind: 'image' | 'audio' | 'document' | 'video';
  text?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Outbound media
// ---------------------------------------------------------------------------

export interface OutboundMediaRequest {
  sessionId: string;
  channel: string;
  chatId: string;
  mediaType: 'image' | 'file' | 'audio' | 'video';
  localPath: string;
  mimeType?: string;
  caption?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MultimodalRuntimeConfig {
  enabled: boolean;
  attachments: {
    cacheDir: string;
    autoParseImages: boolean;
    autoParseDocuments: boolean;
    autoTranscribeAudio: boolean;
  };
}
