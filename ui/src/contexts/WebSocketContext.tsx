import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { getToken } from '../utils/api';

interface WebSocketContextValue {
  connected: boolean;
  lastMessage: unknown | null;
  subscribe: (channel: string, handler: (data: unknown) => void) => () => void;
  /** Send a JSON message to the server via WebSocket. */
  sendMessage: (msg: Record<string, unknown>) => void;
}

const WebSocketContext = createContext<WebSocketContextValue>({
  connected: false,
  lastMessage: null,
  subscribe: () => () => {},
  sendMessage: () => {},
});

const MAX_RECONNECT_DELAY = 30000; // 30s cap
const INITIAL_RECONNECT_DELAY = 1000;

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<unknown | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    // Prevent duplicate connections (e.g. from Strict Mode double-mount)
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/ws?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setConnected(true);
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      // Only reconnect if THIS socket was still the active one.
      // (Strict Mode cleanup closes the old WS after connect() already
      // created a new one — skip reconnecting in that case.)
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      // Reconnect with exponential backoff
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, reconnectDelayRef.current);
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        MAX_RECONNECT_DELAY,
      );
    };

    ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLastMessage(data);

        const channel = data.type || data.channel || 'global';
        const channelHandlers = handlersRef.current.get(channel);
        if (channelHandlers) {
          channelHandlers.forEach((handler) => handler(data));
        }
      } catch {
        // ignore parse errors
      }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((channel: string, handler: (data: unknown) => void) => {
    if (!handlersRef.current.has(channel)) {
      handlersRef.current.set(channel, new Set());
    }
    handlersRef.current.get(channel)!.add(handler);

    return () => {
      handlersRef.current.get(channel)?.delete(handler);
    };
  }, []);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return (
    <WebSocketContext.Provider value={{ connected, lastMessage, subscribe, sendMessage }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}
