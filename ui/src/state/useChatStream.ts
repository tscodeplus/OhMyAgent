/**
 * React bindings for the session-scoped chat stream store.
 *
 * The store lives outside React on purpose (streams must outlive route and
 * session changes), so components read it through `useSyncExternalStore`.
 * Every hook here takes the session id: two sessions streaming at the same
 * time never share state.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { chatStreamStore, type ChatStreamSnapshot } from './chat-stream-store';

const NOOP_UNSUBSCRIBE = () => {};

/** Full stream state of a session (messages, spinner, retry line, liveness). */
export function useChatStream(sessionId?: string): ChatStreamSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) =>
      sessionId ? chatStreamStore.subscribe(sessionId, onChange) : NOOP_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(() => chatStreamStore.snapshot(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Just the "a turn is running" flag. Selecting a primitive keeps the composer
 * from re-rendering on every streamed token.
 */
export function useChatSending(sessionId?: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) =>
      sessionId ? chatStreamStore.subscribe(sessionId, onChange) : NOOP_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(() => chatStreamStore.isSending(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Fires when a turn of this session settles (done/error) — refetch history. */
export function useChatTurnComplete(sessionId: string | undefined, onComplete: () => void): void {
  useEffect(() => {
    if (!sessionId) return;
    return chatStreamStore.subscribeTurnComplete(sessionId, onComplete);
  }, [sessionId, onComplete]);
}
