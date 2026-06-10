import { describe, it, expect, vi } from 'vitest';
import { ReplyApprovalTracker } from '../../extensions/channel-feishu/render/approval-tracker.js';

describe('ReplyApprovalTracker', () => {
  it('sends one approval card per request', async () => {
    const feishuClient = {
      sendApprovalCard: vi.fn(async () => 'approval-msg-1'),
      recallMessage: vi.fn(async () => {}),
    };
    const replyDispatcher = {
      getReplyMessageId: vi.fn(() => 'reply-msg-1'),
      setApprovalRecords: vi.fn(),
    };

    const tracker = new ReplyApprovalTracker({
      feishuClient,
      replyDispatcher: replyDispatcher as any,
    });

    await tracker.addPending({
      requestId: 'req-1',
      command: 'adb shell screencap -p /sdcard/screen.png',
      risk: 'low',
      chatId: 'chat-1',
    });
    expect(feishuClient.sendApprovalCard).toHaveBeenCalledOnce();

    await tracker.resolve('req-1', 'approve_once');
    expect(feishuClient.recallMessage).toHaveBeenCalledWith('approval-msg-1');

    await tracker.addPending({
      requestId: 'req-2',
      command: 'adb pull /sdcard/screen.png /tmp/screen.png',
      risk: 'medium',
      chatId: 'chat-1',
    });
    expect(feishuClient.sendApprovalCard).toHaveBeenCalledTimes(2);
    expect(tracker.getPendingCount()).toBe(1);
  });

  it('ignores duplicate resolve attempts for an already handled request', async () => {
    const feishuClient = {
      sendApprovalCard: vi.fn(async () => 'approval-msg-1'),
      recallMessage: vi.fn(async () => {}),
    };
    const replyDispatcher = {
      getReplyMessageId: vi.fn(() => 'reply-msg-1'),
      setApprovalRecords: vi.fn(),
    };

    const tracker = new ReplyApprovalTracker({
      feishuClient,
      replyDispatcher: replyDispatcher as any,
    });

    await tracker.addPending({
      requestId: 'req-1',
      command: 'rm /tmp/1.txt',
      risk: 'high',
      chatId: 'chat-1',
    });
    await tracker.resolve('req-1', 'reject_once');
    expect(feishuClient.recallMessage).toHaveBeenCalledTimes(1);

    await tracker.resolve('req-1', 'approve_once');
    expect(feishuClient.recallMessage).toHaveBeenCalledTimes(1);
  });
});
