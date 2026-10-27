import { describe, it, expect } from 'vitest';
import {
  INBOX_CHANNELS,
  inferChannel,
  isInboxChannel,
  type SessionChannel,
} from '../../src/memory/session-channel';

describe('inferChannel', () => {
  const cases: Array<[string, string | null | undefined, SessionChannel]> = [
    // WebUI: session id is a uuid, the chat_id carries the marker.
    ['3d1c9a1e-1f2b-4c5d-8e9f-0a1b2c3d4e5f', 'webui:proj-1', 'webui'],
    // chat_id wins over the id prefix (a WebUI session whose id looks foreign).
    ['telegram:42', 'webui:proj-1', 'webui'],
    // IM session ids are the transport chat handles.
    ['telegram:123456', undefined, 'telegram'],
    ['wechat:wxid_abc', null, 'wechat'],
    ['qq:10001', undefined, 'qq'],
    ['cron:daily-report', undefined, 'cron'],
    // Feishu session ids are the raw chat_id, optionally chatId:threadId.
    ['oc_5f1e2d3c4b5a6978', undefined, 'feishu'],
    ['ou_5f1e2d3c4b5a6978', undefined, 'feishu'],
    ['on_5f1e2d3c4b5a6978', undefined, 'feishu'],
    ['om_5f1e2d3c4b5a6978', undefined, 'feishu'],
    ['cli_a1b2c3d4', undefined, 'feishu'],
    ['oc_5f1e2d3c4b5a6978:om_9e8d7c6b5a4f', undefined, 'feishu'],
    // Anything else is unrecognised rather than guessed.
    ['3d1c9a1e-1f2b-4c5d-8e9f-0a1b2c3d4e5f', null, 'unknown'],
    ['default', undefined, 'unknown'],
    ['', undefined, 'unknown'],
  ];

  for (const [sessionId, chatId, expected] of cases) {
    it(`maps id=${JSON.stringify(sessionId)} chatId=${JSON.stringify(chatId)} to ${expected}`, () => {
      expect(inferChannel(sessionId, chatId)).toBe(expected);
    });
  }
});

describe('INBOX_CHANNELS', () => {
  it('lists IM channels first, in display order', () => {
    expect([...INBOX_CHANNELS]).toEqual([
      'feishu',
      'telegram',
      'wechat',
      'qq',
      'webui',
      'cron',
      'unknown',
    ]);
  });
});

describe('isInboxChannel', () => {
  it('accepts every known channel', () => {
    for (const channel of INBOX_CHANNELS) {
      expect(isInboxChannel(channel)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isInboxChannel('discord')).toBe(false);
    expect(isInboxChannel('')).toBe(false);
    expect(isInboxChannel('FEISHU')).toBe(false);
  });
});
