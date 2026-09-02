/**
 * Tests for createWSCardActionHandler — Feishu card button callbacks
 * received via WebSocket (approval approve/deny).
 *
 * Security focus: only the request initiator (requester_id) may decide an
 * approval. A mismatched operator must be rejected without resolving the
 * request.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWSCardActionHandler } from '../../src/app/feishu/ws-card-action-handler.js';
import { harnessApprovalRegistry } from '../../src/harness/harness-approval-registry.js';

interface FakeApprovalRequest {
  id: string;
  requester_id: string | null;
}

function makeHandler(opts: {
  requesterId?: string | null;
  resolveResult?: boolean;
  existingDecision?: { decision: string } | null;
}) {
  const requests = new Map<string, FakeApprovalRequest>();
  if (opts.requesterId !== undefined) {
    requests.set('req-1', { id: 'req-1', requester_id: opts.requesterId });
  }

  const approvalRequestRepo = {
    findById: vi.fn((id: string) => requests.get(id)),
    update: vi.fn(),
  };
  const approvalDecisionRepository = {
    create: vi.fn(),
    findLatestByRequestId: vi.fn(() => opts.existingDecision ?? null),
  };
  const agentFactory = {
    resolveApproval: vi.fn(() => opts.resolveResult ?? true),
  };
  const replyApprovalRegistry = {
    get: vi.fn(() => undefined),
  };

  const handler = createWSCardActionHandler({
    agentFactory: agentFactory as any,
    replyApprovalRegistry: replyApprovalRegistry as any,
    approvalDecisionRepository: approvalDecisionRepository as any,
    approvalRequestRepo: approvalRequestRepo as any,
  });

  return { handler, approvalRequestRepo, approvalDecisionRepository, agentFactory };
}

const APPROVE_VALUE = {
  action: 'approve_once',
  requestId: 'req-1',
  command: 'adb shell rm -rf /tmp/x',
  risk: 'medium',
};

describe('createWSCardActionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the approval when the operator is the requester', async () => {
    const { handler, agentFactory, approvalDecisionRepository } = makeHandler({
      requesterId: 'ou_requester',
    });

    const result = await handler({
      operator: { openId: 'ou_requester' },
      action: { value: APPROVE_VALUE },
      context: { open_message_id: 'om_1' },
    });

    expect(agentFactory.resolveApproval).toHaveBeenCalledWith('req-1', 'approve_once');
    expect(approvalDecisionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req-1',
        decided_by: 'ou_requester',
        decision: 'approve_once',
      }),
    );
    expect(result).toHaveProperty('toast');
  });

  it('rejects the callback when the operator is not the requester', async () => {
    const { handler, agentFactory, approvalDecisionRepository } = makeHandler({
      requesterId: 'ou_requester',
    });

    const result = await handler({
      operator: { openId: 'ou_attacker' },
      action: { value: APPROVE_VALUE },
    });

    // Must NOT resolve, must NOT persist a decision, and must surface an error toast.
    expect(agentFactory.resolveApproval).not.toHaveBeenCalled();
    expect(approvalDecisionRepository.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: expect.objectContaining({ type: 'error' }),
    });
  });

  it('rejects when no operator id is present in the callback', async () => {
    const { handler, agentFactory } = makeHandler({ requesterId: 'ou_requester' });

    const result = await handler({
      action: { value: APPROVE_VALUE },
    });

    expect(agentFactory.resolveApproval).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: expect.objectContaining({ type: 'error' }),
    });
  });

  it('supports the HTTP card action body shape (operator.open_id)', async () => {
    const { handler, agentFactory } = makeHandler({ requesterId: 'ou_requester' });

    const result = await handler({
      operator: { open_id: 'ou_requester' },
      action: { value: APPROVE_VALUE },
    });

    expect(agentFactory.resolveApproval).toHaveBeenCalledWith('req-1', 'approve_once');
    expect(result).toHaveProperty('toast');
  });

  it('fails closed when the request has no recorded requester', async () => {
    const { handler, agentFactory, approvalDecisionRepository } = makeHandler({
      requesterId: null,
    });

    const result = await handler({
      operator: { openId: 'ou_requester' },
      action: { value: APPROVE_VALUE },
    });

    expect(agentFactory.resolveApproval).not.toHaveBeenCalled();
    expect(approvalDecisionRepository.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: expect.objectContaining({ type: 'error' }),
    });
  });

  it('keeps the requester able to act after a rejected attacker attempt', async () => {
    const { handler, agentFactory } = makeHandler({ requesterId: 'ou_requester' });

    // Attacker clicks first — rejected.
    await handler({
      operator: { openId: 'ou_attacker' },
      action: { value: APPROVE_VALUE },
    });
    expect(agentFactory.resolveApproval).not.toHaveBeenCalled();

    // Requester clicks — accepted.
    await handler({
      operator: { openId: 'ou_requester' },
      action: { value: APPROVE_VALUE },
    });
    expect(agentFactory.resolveApproval).toHaveBeenCalledWith('req-1', 'approve_once');
  });

  it('returns early when requestId/action are missing (non-approval buttons)', async () => {
    const { handler, agentFactory } = makeHandler({ requesterId: 'ou_requester' });

    const result = await handler({
      operator: { openId: 'ou_requester' },
      action: { value: { action: 'expand_history' } },
    });

    expect(result).toEqual({ code: 0 });
    expect(agentFactory.resolveApproval).not.toHaveBeenCalled();
  });
});

describe('createWSCardActionHandler — answer_question (user question cards)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeQuestionHandler() {
    const resolve = vi.fn(() => true);
    const handler = createWSCardActionHandler({
      agentFactory: {} as any,
      replyApprovalRegistry: { get: vi.fn(() => undefined) } as any,
      approvalDecisionRepository: { create: vi.fn() } as any,
      approvalRequestRepo: { findById: vi.fn(() => undefined) } as any,
      userQuestionStore: { resolve } as any,
    });
    return { handler, resolve };
  }

  it('resolves a button answer from action.value', async () => {
    const { handler, resolve } = makeQuestionHandler();
    const result = await handler({
      action: { value: { action: 'answer_question', requestId: 'req-q', answer: '中餐' } },
    });
    expect(resolve).toHaveBeenCalledWith('req-q', '中餐');
    expect(result.card).toBeDefined();
  });

  it('resolves a dropdown answer delivered in action.option (JSON string)', async () => {
    const { handler, resolve } = makeQuestionHandler();
    const optionPayload = JSON.stringify({
      action: 'answer_question',
      requestId: 'req-q',
      answer: '使用密钥认证并启用自动重试机制',
    });
    const result = await handler({
      action: {
        tag: 'select_static',
        option: optionPayload,
        value: { action: 'answer_question', requestId: 'req-q' },
      },
    });
    expect(resolve).toHaveBeenCalledWith('req-q', '使用密钥认证并启用自动重试机制');
    expect(result.card).toBeDefined();
  });

  it('resolves a dropdown answer when the option value arrives already parsed', async () => {
    const { handler, resolve } = makeQuestionHandler();
    await handler({
      action: {
        tag: 'select_static',
        option: { action: 'answer_question', requestId: 'req-q', answer: '选项 A' },
      },
    });
    expect(resolve).toHaveBeenCalledWith('req-q', '选项 A');
  });

  it('tolerates a plain (non-JSON) option value as the answer itself', async () => {
    const { handler, resolve } = makeQuestionHandler();
    await handler({
      action: {
        tag: 'select_static',
        option: '中餐',
        value: { action: 'answer_question', requestId: 'req-q' },
      },
    });
    expect(resolve).toHaveBeenCalledWith('req-q', '中餐');
  });

  it('parses a JSON-string action.value (legacy button encoding)', async () => {
    const { handler, resolve } = makeQuestionHandler();
    await handler({
      action: {
        value: JSON.stringify({ action: 'answer_question', requestId: 'req-q', answer: '西餐' }),
      },
    });
    expect(resolve).toHaveBeenCalledWith('req-q', '西餐');
  });

  it('returns the already-answered card when the question was resolved elsewhere', async () => {
    const resolve = vi.fn(() => false);
    const handler = createWSCardActionHandler({
      agentFactory: {} as any,
      replyApprovalRegistry: { get: vi.fn(() => undefined) } as any,
      approvalDecisionRepository: { create: vi.fn() } as any,
      approvalRequestRepo: { findById: vi.fn(() => undefined) } as any,
      userQuestionStore: { resolve } as any,
    });
    const result = await handler({
      action: { value: { action: 'answer_question', requestId: 'req-gone', answer: '中餐' } },
    });
    expect(result.toast).toMatchObject({ type: 'info' });
    expect(result.card).toBeDefined();
  });
});

describe('createWSCardActionHandler — harness improvement (task failure analysis)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harnessApprovalRegistry.remove('prop-1');
  });

  function registerPendingProposal() {
    const resolveFn = vi.fn();
    harnessApprovalRegistry.register({
      proposalId: 'prop-1',
      channel: 'feishu',
      chatId: 'oc_chat',
      editedDefault: 'current skill content',
      resolve: resolveFn,
    });
    return resolveFn;
  }

  it('swaps in an edit form card on edit click without resolving the proposal', async () => {
    const { handler } = makeHandler({});
    registerPendingProposal();

    const result = await handler({
      operator: { openId: 'ou_requester' },
      action: { value: { proposalId: 'prop-1', action: 'edit' } },
    });

    // Proposal stays pending until the form is submitted.
    expect(harnessApprovalRegistry.has('prop-1')).toBe(true);
    const card = (
      result as { card?: { data: { body: { elements: Array<Record<string, any>> } } } }
    ).card;
    expect(card).toBeDefined();
    expect(card!.data.schema).toBe('2.0');
    const form = card!.data.body.elements.find((el) => el.tag === 'form');
    expect(form).toBeDefined();
    const input = form.elements.find((el) => el.tag === 'input');
    expect(input.name).toBe('editedValue');
    expect(input.default_value).toBe('current skill content');
    // JSON 2.0 gives the edit input multiline support.
    expect(input.input_type).toBe('multiline_text');
    const submit = form.elements.find((el) => el.tag === 'button');
    expect(submit.form_action_type).toBe('submit');
    expect(submit.value).toEqual({ proposalId: 'prop-1', action: 'edit_submit' });
  });

  it('resolves the proposal with the edited value on edit_submit', async () => {
    const { handler } = makeHandler({});
    const resolveFn = registerPendingProposal();

    const result = await handler({
      operator: { openId: 'ou_requester' },
      action: {
        value: { proposalId: 'prop-1', action: 'edit_submit' },
        form_value: { editedValue: 'user-edited content' },
      },
    });

    expect(resolveFn).toHaveBeenCalledWith('edit', 'user-edited content');
    expect(harnessApprovalRegistry.has('prop-1')).toBe(false);
    // Card is replaced with the decision result — no buttons left.
    const data = (result as { card?: { data: { elements: unknown[] } } }).card?.data;
    expect(JSON.stringify(data)).not.toContain('"tag":"button"');
  });

  it('replaces a stale proposal card with the handled result', async () => {
    const { handler } = makeHandler({});

    const result = await handler({
      operator: { openId: 'ou_requester' },
      action: { value: { proposalId: 'prop-1', action: 'approve' } },
    });

    expect(result).toMatchObject({ toast: { type: 'info' } });
    const data = (result as { card?: { data: { header: { title: { content: string } } } } })
      .card?.data;
    expect(data?.header.title.content).toContain('This card has been handled');
  });
});
