import type { ApprovalDecisionType } from '../../../src/app/types.js';
import { renderApprovalCard } from './approval-card-renderer.js';
import type { ReplyApprovalRegistry } from './reply-approval-registry.js';
import type { ReplyDispatcher } from '../../../src/app/types.js';

export interface ReplyApprovalRecord {
  requestId: string;
  command: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected';
  decision?: ApprovalDecisionType;
  updatedAt: number;
  approvalMessageId?: string;
}

export interface ReplyApprovalTrackerOptions {
  feishuClient: {
    sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string>;
    recallMessage(messageId: string): Promise<void>;
  };
  replyDispatcher?: ReplyDispatcher;
  registry?: ReplyApprovalRegistry;
}

export class ReplyApprovalTracker {
  private readonly records: ReplyApprovalRecord[] = [];

  constructor(private readonly options: ReplyApprovalTrackerOptions) {}

  async addPending(request: {
    requestId: string;
    command: string;
    risk: 'low' | 'medium' | 'high';
    reason?: string;
    chatId?: string;
  }): Promise<string | undefined> {
    const record: ReplyApprovalRecord = {
      requestId: request.requestId,
      command: request.command,
      risk: request.risk,
      status: 'pending',
      updatedAt: Date.now(),
    };
    this.records.push(record);

    const mainMessageId = this.options.replyDispatcher?.getReplyMessageId();
    if (mainMessageId) {
      this.options.registry?.register(mainMessageId, this);
    }

    let approvalMessageId: string | undefined;
    if (request.chatId) {
      approvalMessageId = await this.options.feishuClient.sendApprovalCard(
        request.chatId,
        renderApprovalCard({
          id: request.requestId,
          command: request.command,
          risk: request.risk,
          reason: request.reason,
          sessionId: '',
          timestamp: Date.now(),
        }),
      );
      record.approvalMessageId = approvalMessageId;
      this.options.registry?.register(approvalMessageId, this);
    }

    return approvalMessageId;
  }

  async resolve(requestId: string, decision: ApprovalDecisionType, opts?: { skipRecall?: boolean }): Promise<void> {
    const record = this.records.find(item => item.requestId === requestId);
    if (!record) return;
    if (record.status !== 'pending') return;

    record.status = decision.startsWith('approve') ? 'approved' : 'rejected';
    record.decision = decision;
    record.updatedAt = Date.now();
    const approvalMessageId = record.approvalMessageId;
    record.approvalMessageId = undefined;

    if (approvalMessageId) {
      this.options.registry?.unregister(approvalMessageId);
      if (!opts?.skipRecall) {
        await this.options.feishuClient.recallMessage(approvalMessageId);
      }
    }
  }

  getPendingCount(): number {
    return this.records.filter(record => record.status === 'pending').length;
  }

  getRecords(): ReplyApprovalRecord[] {
    return this.records.map(record => ({ ...record }));
  }

  getApprovalMessageId(requestId: string): string | undefined {
    return this.records.find(r => r.requestId === requestId)?.approvalMessageId;
  }

  /** Clear the approvalMessageId so resolve() won't recall it. Used when the card is already updated externally (e.g. timeout auto-rejection). */
  clearApprovalMessageId(requestId: string): void {
    const record = this.records.find(r => r.requestId === requestId);
    if (record?.approvalMessageId) {
      this.options.registry?.unregister(record.approvalMessageId);
      record.approvalMessageId = undefined;
    }
  }
}
