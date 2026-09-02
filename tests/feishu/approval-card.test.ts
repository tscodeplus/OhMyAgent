import { i18n } from '../../src/i18n/index.js';
import { describe, it, expect } from 'vitest';
import {
  renderApprovalCard,
  renderApprovalQueueCard,
  assessCommandRisk,
} from '../../extensions/channel-feishu/render/approval-card-renderer.js';
import type { ApprovalRequest } from '../../extensions/channel-feishu/render/approval-card-renderer.js';

// ─── 2.0 structure helpers ───

/** Recursively collect every `button` element from a JSON 2.0 card body. */
function findButtons(node: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.tag === 'button') found.push(obj);
      Object.values(obj).forEach(walk);
    }
  };
  walk(node);
  return found;
}

function bodyElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card.body as Record<string, unknown>;
  return body.elements as Array<Record<string, unknown>>;
}


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

    expect(card.schema).toBe('2.0');
    expect(card.header).toBeDefined();
    expect(card.config).toBeUndefined();
    expect(bodyElements(card)).toBeInstanceOf(Array);
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
    const elements = bodyElements(card);
    const firstEl = elements[0] as Record<string, unknown>;

    expect(firstEl.tag).toBe('markdown');
    expect(firstEl.content).toContain('adb shell ls');
  });

  it('includes description when provided', () => {
    const req: ApprovalRequest = { ...baseRequest, description: 'List files' };
    const card = renderApprovalCard(req) as Record<string, unknown>;
    const elements = bodyElements(card);
    const descEl = elements[2] as Record<string, unknown>; // index 2 after command + risk

    expect(descEl.tag).toBe('markdown');
    expect(descEl.content).toContain('List files');
  });

  it('omits description element when not provided', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;
    const elements = bodyElements(card);

    // Should have: markdown(command), markdown(risk), hr, 2 button column_set rows
    // (no description element)
    expect(elements).toHaveLength(5);
  });

  it('contains four action buttons with correct values', () => {
    const card = renderApprovalCard(baseRequest) as Record<string, unknown>;
    const buttons = findButtons(bodyElements(card));

    expect(buttons).toHaveLength(4);

    const expectedActions = ['approve_once', 'approve_session', 'approve_always', 'reject_once'];

    for (let i = 0; i < expectedActions.length; i++) {
      const value = buttons[i].value as Record<string, unknown>;
      expect(value.action).toBe(expectedActions[i]);
      expect(value.requestId).toBe('req-001');
      // 2.0 callbacks: behaviors must mirror the legacy value.
      const behaviors = buttons[i].behaviors as Array<Record<string, unknown>>;
      expect(behaviors[0]).toMatchObject({ type: 'callback', value });
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

    const elements = bodyElements(card);
    const summary = elements[0] as Record<string, unknown>;
    expect(summary.tag).toBe('markdown');
    expect(summary.content).toBe(i18n.t('feishu-cards:overview.summary', { total: 2, pending: 1 }));
    expect(elements.some((element) => element.tag === 'hr')).toBe(true);

    const buttons = findButtons(elements);
    expect(buttons[0]?.value).toMatchObject({ requestId: 'req-2', action: 'approve_once' });

    const historyEl = elements[elements.length - 1] as Record<string, unknown>;
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
    expect((header.title as Record<string, unknown>).content).toBe(
      i18n.t('feishu-cards:card.approvalComplete'),
    );
    expect(header.template).toBe('green');

    const elements = bodyElements(card);
    expect(findButtons(elements)).toHaveLength(0);

    const statusEl = elements.find(
      (element) =>
        typeof element.content === 'string' &&
        element.content.includes(i18n.t('feishu-cards:overview.allDone')),
    );
    expect(statusEl).toBeDefined();

    const historyEl = elements[elements.length - 1] as Record<string, unknown>;
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.approvedOnce'));
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.rejectedOnce'));
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.rejectedAlways'));
    expect(historyEl.content).toContain(i18n.t('feishu-cards:status.alwaysAllow'));
    expect(historyEl.content).toContain('rm /tmp/101.txt');
    expect(historyEl.content).toContain('rm /tmp/40.txt');
  });

  it('keeps collapse button available after history is expanded in completed state', () => {
    const card = renderApprovalQueueCard(
      [
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
      ],
      { expanded: true, initialVisibleCount: 3 },
    ) as Record<string, unknown>;

    const elements = bodyElements(card);
    const collapseButton = findButtons(elements).find(
      (button) => (button.value as Record<string, unknown>).action === 'collapse_history',
    );
    expect(collapseButton).toBeDefined();
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
