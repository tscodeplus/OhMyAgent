import type { MediaResource } from '../../channel/types.js';
import type { AttachmentIngestInput } from './attachment-store.js';

export interface AttachmentResolver {
  resolveFromChannel(resource: MediaResource, sessionId: string, messageId: string): Promise<AttachmentIngestInput>;
}

export class AttachmentResolverImpl implements AttachmentResolver {
  constructor(private deps: {
    feishuDownload?: (messageId: string, fileKey: string, type: string) => Promise<{ buffer: Buffer; contentType?: string; fileName?: string }>;
  }) {}

  async resolveFromChannel(resource: MediaResource, sessionId: string, messageId: string): Promise<AttachmentIngestInput> {
    // Feishu path: resource.url is actually an image_key/file_key
    if (this.deps.feishuDownload && resource.url) {
      const result = await this.deps.feishuDownload(messageId, resource.url, resource.type);
      return {
        sessionId,
        messageId,
        source: { kind: 'buffer', buffer: result.buffer, fileName: result.fileName ?? resource.name },
        mimeType: result.contentType,
        fileName: result.fileName ?? resource.name,
      };
    }

    // Generic HTTP path
    return {
      sessionId,
      messageId,
      source: { kind: 'url', url: resource.url },
      fileName: resource.name,
    };
  }
}
