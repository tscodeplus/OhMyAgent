// ---------------------------------------------------------------------------
// Tests for the chat media extraction policy
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  CHAT_MEDIA_TOOL_NAMES,
  isChatMediaUrl,
} from '../../src/shared/chat-media.js';

describe('CHAT_MEDIA_TOOL_NAMES', () => {
  it('includes gateway media-emitting tools', () => {
    expect(CHAT_MEDIA_TOOL_NAMES.has('webui_send_media')).toBe(true);
    expect(CHAT_MEDIA_TOOL_NAMES.has('computer_use')).toBe(true);
  });

  it('excludes search/web tools whose outputs carry untrusted snippets', () => {
    expect(CHAT_MEDIA_TOOL_NAMES.has('web_search')).toBe(false);
    expect(CHAT_MEDIA_TOOL_NAMES.has('web_fetch')).toBe(false);
    expect(CHAT_MEDIA_TOOL_NAMES.has('tool_search')).toBe(false);
  });
});

describe('isChatMediaUrl', () => {
  it('accepts gateway-served and data: URLs', () => {
    expect(isChatMediaUrl('/api/files/serve?path=/data/img.png')).toBe(true);
    expect(isChatMediaUrl('/dl/token/img.png')).toBe(true);
    expect(isChatMediaUrl('/desktop-bridge-download?path=C%3A%5Cimg.png')).toBe(true);
    expect(isChatMediaUrl('data:image/png;base64,AAAA')).toBe(true);
  });

  it('rejects external URLs scraped from web pages', () => {
    expect(isChatMediaUrl('https://i.v2ex.co/abc.png')).toBe(false);
    expect(isChatMediaUrl('http://example.com/photo.jpg')).toBe(false);
  });
});
