/**
 * ChatQueue — per-session FIFO task queue.
 *
 * Same session: tasks run serially (one at a time).
 * Different sessions: tasks run in parallel (no global lock).
 * Errors in one session do not affect other sessions.
 * Auto-cleans queues when empty.
 */

export type TaskFn = () => Promise<void>;

export class ChatQueue {
  private queues: Map<string, TaskFn[]> = new Map();
  private running: Map<string, boolean> = new Map();

  /**
   * Enqueue a task for a given session.
   * Starts processing immediately if the session is idle.
   * Returns immediately — does NOT wait for the task to complete.
   */
  enqueue(sessionKey: string, task: TaskFn): void {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = [];
      this.queues.set(sessionKey, queue);
    }

    queue.push(task);

    // If session is idle, start processing asynchronously
    if (!this.running.get(sessionKey)) {
      void this.processNext(sessionKey);
    }
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
      console.warn(`[ChatQueue] task failed for session ${sessionKey}:`, err);
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
