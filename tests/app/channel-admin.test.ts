/**
 * Tests for createChannelIsAdmin — the channel-aware admin check behind
 * privileged slash commands (/permission).
 *
 * The shared CommandDeps instance is used by every channel, so the check
 * must resolve the operator's own channel's allowedUsers and chat-type
 * semantics (Feishu p2p, Telegram private, WeChat 1:1, QQ c2c).
 */

import { describe, it, expect } from 'vitest';
import { createChannelIsAdmin } from '../../src/app/composers/feishu-services.js';
import type { AppConfig } from '../../src/app/types.js';

function makeConfig(
  overrides: Partial<
    Record<'feishu' | 'telegram' | 'wechat' | 'qq', { allowedUsers: string[] }>
  > = {},
): AppConfig {
  return {
    feishu: { allowedUsers: [] },
    telegram: { allowedUsers: [] },
    wechat: { allowedUsers: [] },
    qq: { allowedUsers: [] },
    ...overrides,
  } as unknown as AppConfig;
}

describe('createChannelIsAdmin', () => {
  it('feishu: p2p chat is admin, group chat is not (no whitelist)', () => {
    const isAdmin = createChannelIsAdmin(makeConfig());
    expect(isAdmin({ senderId: 'ou_1', chatType: 'p2p', channel: 'feishu' })).toBe(true);
    expect(isAdmin({ senderId: 'ou_1', chatType: 'group', channel: 'feishu' })).toBe(false);
  });

  it('feishu: defaults to feishu semantics when channel is omitted', () => {
    const isAdmin = createChannelIsAdmin(makeConfig());
    expect(isAdmin({ senderId: 'ou_1', chatType: 'p2p' })).toBe(true);
    expect(isAdmin({ senderId: 'ou_1', chatType: 'group' })).toBe(false);
  });

  it('feishu: allowedUsers whitelist overrides chat-type rule', () => {
    const isAdmin = createChannelIsAdmin(makeConfig({ feishu: { allowedUsers: ['ou_admin'] } }));
    expect(isAdmin({ senderId: 'ou_admin', chatType: 'group', channel: 'feishu' })).toBe(true);
    expect(isAdmin({ senderId: 'ou_other', chatType: 'p2p', channel: 'feishu' })).toBe(false);
    // Empty sender with a whitelist configured is never an admin
    expect(isAdmin({ senderId: undefined, chatType: 'p2p', channel: 'feishu' })).toBe(false);
  });

  it('telegram: private chat is admin, group/supergroup is not', () => {
    const isAdmin = createChannelIsAdmin(makeConfig());
    expect(isAdmin({ senderId: 't1', chatType: 'private', channel: 'telegram' })).toBe(true);
    expect(isAdmin({ senderId: 't1', chatType: 'group', channel: 'telegram' })).toBe(false);
    expect(isAdmin({ senderId: 't1', chatType: 'supergroup', channel: 'telegram' })).toBe(false);
  });

  it('telegram: allowedUsers whitelist applies', () => {
    const isAdmin = createChannelIsAdmin(makeConfig({ telegram: { allowedUsers: ['t_admin'] } }));
    expect(isAdmin({ senderId: 't_admin', chatType: 'supergroup', channel: 'telegram' })).toBe(
      true,
    );
    expect(isAdmin({ senderId: 't_other', chatType: 'private', channel: 'telegram' })).toBe(false);
  });

  it('wechat: always admin (1:1 personal bot) without a whitelist', () => {
    const isAdmin = createChannelIsAdmin(makeConfig());
    expect(isAdmin({ senderId: 'wx_1', chatType: 'p2p', channel: 'wechat' })).toBe(true);
  });

  it('wechat: allowedUsers whitelist applies', () => {
    const isAdmin = createChannelIsAdmin(makeConfig({ wechat: { allowedUsers: ['wx_admin'] } }));
    expect(isAdmin({ senderId: 'wx_admin', channel: 'wechat' })).toBe(true);
    expect(isAdmin({ senderId: 'wx_other', channel: 'wechat' })).toBe(false);
  });

  it('qq: c2c chat is admin, group chat is not', () => {
    const isAdmin = createChannelIsAdmin(makeConfig());
    expect(isAdmin({ senderId: 'qq_1', chatType: 'c2c', channel: 'qq' })).toBe(true);
    expect(isAdmin({ senderId: 'qq_1', chatType: 'group', channel: 'qq' })).toBe(false);
  });

  it('qq: allowedUsers whitelist overrides chat-type rule', () => {
    const isAdmin = createChannelIsAdmin(makeConfig({ qq: { allowedUsers: ['qq_admin'] } }));
    expect(isAdmin({ senderId: 'qq_admin', chatType: 'group', channel: 'qq' })).toBe(true);
    expect(isAdmin({ senderId: 'qq_other', chatType: 'c2c', channel: 'qq' })).toBe(false);
  });
});
