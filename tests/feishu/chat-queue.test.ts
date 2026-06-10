import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatQueue } from '../../extensions/channel-feishu/chat-queue.js';

describe('ChatQueue', () => {
  let queue: ChatQueue;

  beforeEach(() => {
    queue = new ChatQueue();
  });

  describe('enqueue', () => {
    it('should execute an enqueued task', async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      queue.enqueue('session-1', fn);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fn).toHaveBeenCalledOnce();
    });

    it('should execute multiple tasks for the same session serially', async () => {
      const order: number[] = [];

      // First task takes some time
      const task1 = vi.fn().mockImplementation(async () => {
        order.push(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(2);
      });

      // Second task is fast
      const task2 = vi.fn().mockImplementation(async () => {
        order.push(3);
      });

      // Enqueue both — second should wait for first
      queue.enqueue('session-1', task1);
      queue.enqueue('session-1', task2); // Not awaited — it should queue up

      // Give a moment for second task to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(order).toEqual([1, 2, 3]);
    });

    it('should execute tasks for different sessions in parallel', async () => {
      const session1Order: number[] = [];
      const session2Order: number[] = [];
      const barrier = { resolve: undefined as (() => void) | undefined };
      const barrierPromise = new Promise<void>((r) => {
        barrier.resolve = r;
      });

      const session1Task = vi.fn().mockImplementation(async () => {
        session1Order.push(1);
        await barrierPromise; // Wait for signal
        session1Order.push(2);
      });

      const session2Task = vi.fn().mockImplementation(async () => {
        session2Order.push(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        session2Order.push(2);
      });

      // Start both sessions
      queue.enqueue('session-1', session1Task);
      queue.enqueue('session-2', session2Task);

      // Wait for session-2 to complete (it runs in parallel)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Session 2 should have completed both steps while session 1 is still waiting
      expect(session2Order).toEqual([1, 2]);
      expect(session1Order).toEqual([1]); // Still waiting at barrier

      // Release session 1
      barrier.resolve!();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(session1Order).toEqual([1, 2]);
    });

    it('should not block different sessions when one session has errors', async () => {
      const session2Result: number[] = [];

      const failingTask = vi.fn().mockRejectedValue(new Error('session-1 error'));
      const session2Task = vi.fn().mockImplementation(async () => {
        session2Result.push(1);
      });

      // Both sessions enqueue
      queue.enqueue('session-1', failingTask);
      queue.enqueue('session-2', session2Task);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Session 2 should complete successfully despite session 1 error
      expect(session2Task).toHaveBeenCalledOnce();
      expect(session2Result).toEqual([1]);
    });

    it('should continue processing remaining tasks after an error', async () => {
      const order: number[] = [];

      const failingTask = vi.fn().mockRejectedValue(new Error('fail'));
      const successTask = vi.fn().mockImplementation(async () => {
        order.push('success');
      });

      queue.enqueue('session-1', failingTask);
      queue.enqueue('session-1', successTask);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(order).toEqual(['success']);
    });
  });

  describe('getQueueSize', () => {
    it('should return 0 for unknown sessions', () => {
      expect(queue.getQueueSize('unknown')).toBe(0);
    });

    it('should track pending tasks correctly', async () => {
      const barrier = { resolve: undefined as (() => void) | undefined };
      const barrierPromise = new Promise<void>((r) => {
        barrier.resolve = r;
      });

      const blockingTask = vi.fn().mockImplementation(async () => {
        await barrierPromise;
      });

      // Enqueue blocking task + 2 more
      queue.enqueue('session-1', blockingTask);
      queue.enqueue('session-1', vi.fn().mockResolvedValue(undefined));
      queue.enqueue('session-1', vi.fn().mockResolvedValue(undefined));

      // The blocking task is running, 2 are pending
      expect(queue.getQueueSize('session-1')).toBe(2);

      // Release
      barrier.resolve!();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After all tasks complete, queue should be cleaned up
      expect(queue.getQueueSize('session-1')).toBe(0);
    });
  });

  describe('isProcessing', () => {
    it('should return false for unknown sessions', () => {
      expect(queue.isProcessing('unknown')).toBe(false);
    });

    it('should return true while a task is running', async () => {
      const barrier = { resolve: undefined as (() => void) | undefined };
      const barrierPromise = new Promise<void>((r) => {
        barrier.resolve = r;
      });

      const blockingTask = vi.fn().mockImplementation(async () => {
        await barrierPromise;
      });

      queue.enqueue('session-1', blockingTask);

      // Give a microtask tick for the async to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(queue.isProcessing('session-1')).toBe(true);

      barrier.resolve!();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After processing, should be cleaned up (returns false)
      expect(queue.isProcessing('session-1')).toBe(false);
    });

    it('should return false after all tasks complete', async () => {
      queue.enqueue('session-1', vi.fn().mockResolvedValue(undefined));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queue.isProcessing('session-1')).toBe(false);
    });
  });
});
