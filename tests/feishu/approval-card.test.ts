import { i18n } from '../../src/i18n/index.js';
import { describe, it, expect } from 'vitest';
import {
  renderApprovalCard,
  renderApprovalQueueCard,
  assessCommandRisk,
} from '../../extensions/channel-feishu/render/approval-card-renderer.js';
import type { ApprovalRequest } from '../../extensions/channel-feishu/render/approval-card-renderer.js';
import {
  ApprovalActionHandler,
} from '../../extensions/channel-feishu/feishu-approval-actions.js';
import type {
  ApprovalCallbackData,
} from '../../extensions/channel-feishu/feishu-approval-actions.js';

// ─── renderApprovalCard ───

describe('renderApprovalCard', () => {
  const baseRequest: ApprovalRequest = {
    id: 'req-001',
    command: 'adb shell ls',
    risk: 'low',
    sessionId: 'session-abc',
    timestamp: Date.now(),
  };

  it('returns a valid Feishu interactive card structure', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;

    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.header).toBeDefined();
    expect(card.elements).toBeInstanceOf(Array);
  });

  it('sets header title to "Shell Command Approval"', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;
    const header = card.header as Record<string, unknown>;
    const title = header.title as Record<string, unknown>;

    expect(title.content).toBe('Shell Command Approval');
    expect(title.tag).toBe('plain_text');
  });

  it('includes the command in the card body', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;
    const elements = card.elements as Array<Record<string, unknown>>;
    const firstEl = elements[0] as Record<string, unknown>;
    const text = firstEl.text as Record<string, unknown>;

    expect(text.content).toContain('adb shell ls');
  });

  it('includes description when provided', () => {
    const req: ApprovalRequest = { ...baseRequest, description: 'List files' };
    const card = renderApprovalCard(req) as Record<string, unknown>;
    const elements = card.elements as Array<Record<string, unknown>>;
    const descEl = elements[2] as Record<string, unknown>; // index 2 after command + risk
    const text = descEl.text as Record<string, unknown>;

    expect(text.content).toContain('List files');
  });

  it('omits description element when not provided', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;
    const elements = card.elements as Array<Record<string, unknown>>;

    // Should have: div(command), div(risk), hr, action = 4
    // (no description div)
    expect(elements).toHaveLength(4);
  });

  it('contains four action buttons with correct values', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;
    const elements = card.elements as Array<Record<string, unknown>>;
    const actionEl = elements[elements.length - 1] as Record<string, unknown>;
    const actions = actionEl.actions as Array<Record<string, unknown>>;

    expect(actions).toHaveLength(4);

    const expectedActions = [
      'approve_once',
      'approve_session',
      'approve_always',
      'reject_once',
    ];

    for (let i = 0; i < expectedActions.length; i++) {
      const btn = actions[i] as Record<string, unknown>;
      const value = btn.value as Record<string, unknown>;
      expect(value.action).toBe(expectedActions[i]);
      expect(value.requestId).toBe('req-001');
    }
  });
});

// ─── Risk header template ───

describe('renderApprovalCard risk header templates', () => {
  const makeRequest = (risk: 'low' | 'medium' | 'high'): ApprovalRequest => ({
    id: 'r1',
    command: 'test',
    risk,
    sessionId: 's1',
    timestamp: 0,
  });

  it('uses blue header for low risk', () => {
    const card = renderApprovalCard(makeRequest('low')) as Record<string, unknown>;
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe('blue');
  });

  it('uses blue header for medium risk', () => {
    const card = renderApprovalCard(makeRequest('medium')) as Record<string, unknown>;
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe('blue');
  });

  it('uses blue header for high risk', () => {
    const card = renderApprovalCard(makeRequest('high')) as Record<string, unknown>;
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe('blue');
  });
});

describe('renderApprovalQueueCard', () => {
  it('renders current pending approval and reply history', () => {
    const card = renderApprovalQueueCard([
      {
        requestId: 'req-1',
        command: 'adb shell screencap -p /sdcard/screen.png',
        risk: 'low',
        status: 'approved',
        decision: 'approve_once',
        updatedAt: 1,
      },
      {
        requestId: 'req-2',
        command: 'adb pull /sdcard/screen.png /tmp/screen.png',
        risk: 'medium',
        status: 'pending',
        updatedAt: 2,
      },
    ]) as Record<string, unknown>;

    const header = card.header as Record<string, unknown>;
    expect((header.title as Record<string, unknown>).content).toBe('Reply Approval Queue');

    const elements = card.elements as Array<Record<string, unknown>>;
    const summary = elements[0]?.text as Record<string, unknown>;
    expect(summary.content).toBe(i18n.t('feishu-cards:overview.summary', { total: 2, pending: 1 }));
    expect(elements.some((element) => element.tag === 'hr')).toBe(true);

    const actionEl = elements.find((element) => element.tag === 'action');
    expect(actionEl).toBeDefined();
    const actions = actionEl?.actions as Array<Record<string, unknown>>;
    expect(actions[0]?.value).toMatchObject({ requestId: 'req-2', action: 'approve_once' });

    const historyEl = elements[elements.length - 1]?.text as Record<string, unknown>;
    expect(historyEl.content).toContain('adb shell screencap');
    expect(historyEl.content).toContain('adb pull');
  });

  it('renders completed state without approval buttons and shows full history', () => {
    const card = renderApprovalQueueCard([
      {
        requestId: 'req-1',
        command: 'rm /tmp/101.txt',
        risk: 'high',
        status: 'approved',
        decision: 'approve_once',
        updatedAt: 1,
      },
      {
        requestId: 'req-2',
        command: 'rm /tmp/20/222.txt',
        risk: 'high',
        status: 'rejected',
        decision: 'reject_once',
        updatedAt: 2,
      },
      {
        requestId: 'req-3',
        command: 'rm /tmp/30/2/123.txt',
        risk: 'high',
        status: 'rejected',
        decision: 'reject_always',
        updatedAt: 3,
      },
      {
        requestId: 'req-4',
        command: 'rm /tmp/40.txt',
        risk: 'high',
        status: 'approved',
        decision: 'approve_always',
        updatedAt: 4,
      },
    ]) as Record<string, unknown>;

    const header = card.header as Record<string, unknown>;
    expect((header.title as Record<string, unknown>).content).toBe(i18n.t('feishu-cards:card.approvalComplete'));
    expect(header.template).toBe('green');

    const elements = card.elements as Array<Record<string, unknown>>;
    const actionEls = elements.filter((element) => element.tag === 'action');
    expect(actionEls).toHaveLength(0);

    const statusEl = elements.find((element) => {
      const text = element.text as Record<string, unknown> | undefined;
      return typeof text?.content === 'string' && text.content.includes(i18n.t('feishu-cards:overview.allDone'));
    });
    expect(statusEl).toBeDefined();

    const historyEl = elements[elements.length - 1]?.text as Record<string, unknown>;
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.approvedOnce'));
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.rejectedOnce'));
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.rejectedAlways'));
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.alwaysAllow'));
    expect(historyEl.content).toContain('rm /tmp/101.txt');
    expect(historyEl.content).toContain('rm /tmp/40.txt');
  });

  it('keeps collapse button available after history is expanded in completed state', () => {
    const card = renderApprovalQueueCard([
      {
        requestId: 'req-1',
        command: 'rm /tmp/1.txt',
        risk: 'high',
        status: 'approved',
        decision: 'approve_once',
        updatedAt: 1,
      },
      {
        requestId: 'req-2',
        command: 'rm /tmp/2.txt',
        risk: 'high',
        status: 'rejected',
        decision: 'reject_once',
        updatedAt: 2,
      },
      {
        requestId: 'req-3',
        command: 'rm /tmp/3.txt',
        risk: 'high',
        status: 'approved',
        decision: 'approve_always',
        updatedAt: 3,
      },
      {
        requestId: 'req-4',
        command: 'rm /tmp/4.txt',
        risk: 'high',
        status: 'rejected',
        decision: 'reject_always',
        updatedAt: 4,
      },
    ], { expanded: true, initialVisibleCount: 3 }) as Record<string, unknown>;

    const elements = card.elements as Array<Record<string, unknown>>;
    const actionEl = elements.find((element) =>
      element.tag === 'action' &&
      Array.isArray(element.actions) &&
      (element.actions as Array<Record<string, unknown>>)[0]?.value &&
      ((element.actions as Array<Record<string, unknown>>)[0]?.value as Record<string, unknown>).action === 'collapse_history',
    );
    expect(actionEl).toBeDefined();
  });
});

// ─── assessCommandRisk ───

describe('assessCommandRisk', () => {
  it('returns "high" for install commands', () => {
    expect(assessCommandRisk('adb install app.apk')).toBe('high');
  });

  it('returns "high" for rm commands', () => {
    expect(assessCommandRisk('adb shell rm /data/local/tmp/test')).toBe('high');
  });

  it('returns "high" for uninstall commands', () => {
    expect(assessCommandRisk('adb shell pm uninstall com.example')).toBe('high');
  });

  it('returns "high" for non-ADB kill command', () => {
    expect(assessCommandRisk('kill -9 1234')).toBe('high');
  });

  it('returns "high" for non-ADB rm command', () => {
    expect(assessCommandRisk('rm -rf /tmp/test')).toBe('high');
  });

  it('returns "medium" for connect commands', () => {
    expect(assessCommandRisk('adb connect 192.168.1.100')).toBe('medium');
  });

  it('returns "medium" for push commands', () => {
    expect(assessCommandRisk('adb push file.txt /sdcard/')).toBe('medium');
  });

  it('returns "medium" for pull commands', () => {
    expect(assessCommandRisk('adb pull /sdcard/file.txt .')).toBe('medium');
  });

  it('returns "medium" for shell input commands', () => {
    expect(assessCommandRisk('adb shell input tap 100 200')).toBe('medium');
  });

  it('returns "medium" for dumpsys commands', () => {
    expect(assessCommandRisk('adb shell dumpsys battery')).toBe('medium');
  });

  it('returns "low" for devices command', () => {
    expect(assessCommandRisk('adb devices')).toBe('low');
  });

  it('returns "low" for getprop command', () => {
    expect(assessCommandRisk('adb shell getprop ro.build.version.sdk')).toBe('low');
  });

  it('returns "low" for ls command', () => {
    expect(assessCommandRisk('adb shell ls /sdcard/')).toBe('low');
  });

  it('returns "low" for cat command', () => {
    expect(assessCommandRisk('adb shell cat /etc/hosts')).toBe('low');
  });

  it('returns "low" for unknown commands', () => {
    expect(assessCommandRisk('echo hello')).toBe('low');
  });

  it('returns "low" for version command', () => {
    expect(assessCommandRisk('adb version')).toBe('low');
  });
});

// ─── ApprovalActionHandler ───

describe('ApprovalActionHandler', () => {
  it('returns decision on first callback', () => {
    const handler = new ApprovalActionHandler();
    const data: ApprovalCallbackData = {
      action: 'approve_once',
      requestId: 'req-1',
    };

    const result = handler.handleCallback(data);

    expect(result).toEqual({
      decision: 'approve_once',
      requestId: 'req-1',
    });
  });

  it('returns null on duplicate callback (idempotent)', () => {
    const handler = new ApprovalActionHandler();
    const data: ApprovalCallbackData = {
      action: 'reject_always',
      requestId: 'req-2',
    };

    const first = handler.handleCallback(data);
    const second = handler.handleCallback(data);

    expect(first).toEqual({
      decision: 'reject_always',
      requestId: 'req-2',
    });
    expect(second).toBeNull();
  });

  it('handles different requestIds independently', () => {
    const handler = new ApprovalActionHandler();

    const r1 = handler.handleCallback({ action: 'approve_once', requestId: 'a' });
    const r2 = handler.handleCallback({ action: 'reject_once', requestId: 'b' });

    expect(r1?.decision).toBe('approve_once');
    expect(r2?.decision).toBe('reject_once');
  });

  it('isDecided returns true after processing', () => {
    const handler = new ApprovalActionHandler();

    expect(handler.isDecided('req-x')).toBe(false);

    handler.handleCallback({ action: 'approve_always', requestId: 'req-x' });

    expect(handler.isDecided('req-x')).toBe(true);
  });

  it('getDecision returns the stored decision', () => {
    const handler = new ApprovalActionHandler();

    expect(handler.getDecision('req-y')).toBeUndefined();

    handler.handleCallback({ action: 'reject_always', requestId: 'req-y' });

    expect(handler.getDecision('req-y')).toBe('reject_always');
  });

  it('getDecision returns undefined for unknown requestId', () => {
    const handler = new ApprovalActionHandler();
    expect(handler.getDecision('unknown')).toBeUndefined();
  });
});
