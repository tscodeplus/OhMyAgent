/**
 * ChatQueue — per-session FIFO task queue.
 *
 * Same session: tasks run serially (one at a time).
 * Different sessions: tasks run in parallel (no global lock).
 * Errors in one session do not affect other sessions.
 * Auto-cleans queues when empty.
 *
 * P1 M6: bounded per session — when the pending backlog of a session exceeds
 * `maxPending`, new tasks are rejected (enqueue returns false) so a hung turn
 * cannot accumulate an unbounded message backlog for that session.
 */

export type TaskFn = () => Promise<void>;

export interface ChatQueueOptions {
  /** Max pending (not-yet-started) tasks per session. Default 5. */
  maxPending?: number;
}

const DEFAULT_MAX_PENDING = 5;

export class ChatQueue {
  private queues: Map<string, TaskFn[]> = new Map();
  private running: Map<string, boolean> = new Map();
  private logger?: { warn: (...args: any[]) => void };
  private readonly maxPending: number;

  constructor(options: ChatQueueOptions = {}) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  }

  setLogger(logger: { warn: (...args: any[]) => void }): void {
    this.logger = logger;
  }

  /**
   * Enqueue a task for a given session.
   * Starts processing immediately if the session is idle.
   * Returns immediately — does NOT wait for the task to complete.
   *
   * P1 M6: returns false (and skips the task) when the session's pending
   * backlog is already at maxPending — the caller should reply with a
   * "busy" message instead of silently dropping the user's input.
   */
  enqueue(sessionKey: string, task: TaskFn): boolean {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = [];
      this.queues.set(sessionKey, queue);
    }

    // P1 M6: bounded backlog per session
    if (queue.length >= this.maxPending) {
      this.logger?.warn(
        `[ChatQueue] session ${sessionKey} backlog full (${this.maxPending} pending), rejecting task`,
      );
      return false;
    }

    queue.push(task);

    // If session is idle, start processing asynchronously
    if (!this.running.get(sessionKey)) {
      void this.processNext(sessionKey);
    }
    return true;
  }

  /**
   * Process the next task in the session queue.
   * After each task completes (success or error), process the next one.
   */
  private async processNext(sessionKey: string): Promise<void> {
    const queue = this.queues.get(sessionKey);
    if (!queue || queue.length === 0) {
      this.running.set(sessionKey, false);
      // Auto-clean empty queues
      this.queues.delete(sessionKey);
      this.running.delete(sessionKey);
      return;
    }

    this.running.set(sessionKey, true);
    const task = queue.shift()!;

    try {
      await task();
    } catch (err) {
      // Error in one task does not block the queue
      this.logger?.warn(`[ChatQueue] task failed for session ${sessionKey}:`, err);
    }

    await this.processNext(sessionKey);
  }

  /**
   * Get the number of pending tasks for a session (not counting the currently running one).
   */
  getQueueSize(sessionKey: string): number {
    const queue = this.queues.get(sessionKey);
    if (!queue) return 0;
    // If a task is currently running, it has already been shifted off the queue
    // So queue.length reflects only pending tasks
    return queue.length;
  }

  /**
   * Check if a session currently has a task running.
   */
  isProcessing(sessionKey: string): boolean {
    return this.running.get(sessionKey) === true;
  }
}
