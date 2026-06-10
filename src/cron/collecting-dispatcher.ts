import type { ReplyDispatcher, Usage } from '../app/types.js';

/**
 * Headless ReplyDispatcher that collects text output instead of rendering
 * Feishu cards. Used by cron jobs to capture agent output for delivery.
 */
export class CollectingReplyDispatcher implements ReplyDispatcher {
  private textBuffer = '';
  private error_: Error | null = null;
  private model_: string | null = null;
  private approvalRecords: Array<{
    requestId: string;
    command: string;
    risk: 'low' | 'medium' | 'high';
    status: 'pending' | 'approved' | 'rejected';
    decision?: string;
    updatedAt: number;
  }> = [];
  private approvalStatus: string | null = null;

  onStart(): void {}

  onTextDelta(delta: string): void {
    this.textBuffer += delta;
  }

  onReasoningDelta(_delta: string): void {
    // Ignore reasoning content in headless mode
  }

  onToolStart(_name: string, _args: unknown, _toolCallId?: string): void {}

  onToolEnd(_name: string, _result: unknown, _isError?: boolean, _toolCallId?: string): void {}

  setModel(model: string): void { this.model_ = model; }

  setAgentName(_name: string): void {}

  getModel(): string | null { return this.model_; }

  setApprovalStatus(status: string | null): void {
    this.approvalStatus = status;
  }

  setApprovalRecords(
    records: Array<{
      requestId: string;
      command: string;
      risk: 'low' | 'medium' | 'high';
      status: 'pending' | 'approved' | 'rejected';
      decision?: string;
      updatedAt: number;
    }>,
    _expanded: boolean,
  ): void {
    this.approvalRecords = records;
  }

  getReplyMessageId(): string | undefined {
    return undefined;
  }

  onComplete(_usage?: Usage): void {}

  onError(error: Error): void {
    this.error_ = error;
  }

  onAborted(): void {
    this.error_ = new Error('aborted');
  }

  getOutput(): string {
    return this.textBuffer.trim();
  }

  getError(): Error | null {
    return this.error_;
  }

  hasApprovals(): boolean {
    return this.approvalRecords.length > 0;
  }
}
