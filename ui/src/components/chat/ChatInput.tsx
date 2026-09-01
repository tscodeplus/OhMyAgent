import { useState, useCallback, useRef, useEffect, useMemo, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Send, Paperclip, X, Loader2, Bot, Square, ChevronDown, Check } from 'lucide-react';
import { createSSEClient, type SSEEvent } from '../../utils/sse-client';
import { apiRequest, getToken } from '../../utils/api';
import { devLog } from '../../utils/logger';
import { CHAT_MEDIA_TOOL_NAMES, isChatMediaUrl } from '../../utils/chatMedia';
import type { Message, MessageApproval, UserQuestion, ToolCall, MessageFooter, MessageSegment, MediaSegmentItem, MessageFile } from '../../types/session';

interface SlashCommand {
  id: string;
  /** Optional display name (skills carry their manifest name). */
  name?: string;
  description: string;
  /** True for skill-trigger commands (rendered in a different accent). */
  skill?: boolean;
}

interface ChatInputProps {
  projectId?: string;
  sessionId?: string;
  /** True when the session has no messages yet — renders the input centered
   *  (slightly below middle) instead of docked to the bottom. */
  centered?: boolean;
  /** Called when the user sends a message while NO session exists yet:
   *  the gateway creates a session and navigates to it; the typed text is
   *  auto-sent as the first message via navigation state. */
  onQuickStart?: (text: string) => void;
  /** Called when new messages arrive (streaming or user).
   *  Optional second param controls whether previous streaming messages
   *  are cleared. Default true — pass false for steer/follow-up to
   *  preserve messages from the current turn. */
  onMessages?: (messages: Message[], clearPrevious?: boolean) => void;
  /** Called when a new SSE stream starts (to switch to streaming mode). */
  onStreamStart?: () => void;
  /** Called when the gateway starts thinking (turn_start) / stops (first response content). */
  onThinkingChange?: (thinking: boolean) => void;
  /** Called when the SSE stream completes (done or error). */
  onDone?: () => void;
  /** Called when an assistant turn has fully completed (done/error received).
   *  The server persists the turn content BEFORE dispatching those events,
   *  so the parent can prune the local streaming bubble once its refetch
   *  returns the same content under the server-generated id. */
  onTurnPersisted?: (assistantMsgId: string) => void;
}

interface FileUploadItem {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  path?: string;
  size?: number;
  error?: string;
}

interface AgentOption {
  id: string;
  name: string;
  /** Primary model ref ("provider/modelId") — the model dropdown's default. */
  model?: string;
}

interface ModelGroup {
  provider: string;
  models: Array<{ id: string; name: string }>;
}

const sseClient = createSSEClient();

/** Throttle interval for text_delta → React state updates (~20fps). */
const DELTA_FLUSH_INTERVAL_MS = 50;

/**
 * Generate a random UUID v4 string. Uses crypto.randomUUID() when available
 * (secure contexts: localhost or HTTPS), falls back to Math.random() for
 * non-secure contexts (e.g. accessing the dev server via http://IP:port).
 */
function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ChatInput({ projectId, sessionId, centered, onQuickStart, onMessages, onStreamStart, onThinkingChange, onDone, onTurnPersisted }: ChatInputProps) {
  const { t } = useTranslation('common');
  const location = useLocation();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoSentRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Refs for SSE streaming state — captured by the event handler closure.
  // Reset on turn_start so steer/follow-up responses create separate bubbles.
  const assistantIdRef = useRef('');
  const assistantContentRef = useRef('');
  const assistantCreatedAtRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const runningToolsRef = useRef(new Map<string, ToolCall>());
  /** Chronological timeline of text and tool calls within the current turn. */
  const segmentsRef = useRef<MessageSegment[]>([]);
  /** Length of cleaned assistant text that has already been "flushed" into
   *  segments. Used to compute only the new portion for the current text
   *  segment after a tool-call boundary. */
  const flushedCleanLenRef = useRef(0);
  /** Set to true when steerMessage eagerly creates a bubble so the later
   *  turn_start from the agent reuses it instead of creating a duplicate. */
  const steerBubbleRef = useRef(false);
  const approvalMessagesRef = useRef(new Map<string, Message>());
  const questionMessagesRef = useRef(new Map<string, Message>());
  // Count active turns: incremented on turn_start, decremented on done.
  // sending resets to false only when all turns have completed.
  const activeTurnsRef = useRef(0);

  // Render-time mirror of fileUploads so retryFileUpload can read the latest
  // item WITHOUT side effects inside a state updater (updaters must stay pure
  // — React StrictMode runs them twice, which would double-upload files).
  const fileUploadsRef = useRef<FileUploadItem[]>([]);

  // Pending trailing flush timer for throttled text_delta updates.
  const deltaFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File upload state
  const [fileUploads, setFileUploads] = useState<FileUploadItem[]>([]);
  fileUploadsRef.current = fileUploads;
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** True while the native file-picker dialog is open (attachment button lit). */
  const [attachActive, setAttachActive] = useState(false);

  // Per-session cache — preserves input text and file uploads when switching conversations
  const inputCacheRef = useRef<Map<string, string>>(new Map());
  const fileUploadsCacheRef = useRef<Map<string, FileUploadItem[]>>(new Map());
  const prevSessionIdRef = useRef(sessionId);

  // ── Agent / Model selectors (right of the slash button) ──
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [projectAgentId, setProjectAgentId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  // Project's default agent — the agent dropdown's initial value.
  useEffect(() => {
    if (!projectId) { setProjectAgentId(null); return; }
    let cancelled = false;
    apiRequest<{ agent_id?: string }>(`/api/projects/${projectId}`)
      .then(data => { if (!cancelled) setProjectAgentId(data?.agent_id ?? null); })
      .catch(() => { if (!cancelled) setProjectAgentId(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Configured agents list.
  useEffect(() => {
    let cancelled = false;
    apiRequest<AgentOption[]>('/api/agents')
      .then(data => { if (!cancelled) setAgents(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, []);

  // Model catalog grouped by configured provider (builtin with key + custom).
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ providers: Array<{ id: string }> }>('/api/providers/configured')
      .then(async (data) => {
        const providers = data?.providers ?? [];
        const groups = await Promise.all(providers.map(async (p) => {
          try {
            const res = await apiRequest<{ models: Array<{ id: string; name?: string }> }>(`/api/providers/${p.id}/models`);
            return { provider: p.id, models: (res?.models ?? []).map(m => ({ id: m.id, name: m.name || m.id })) };
          } catch {
            return { provider: p.id, models: [] };
          }
        }));
        if (!cancelled) setModelGroups(groups.filter(g => g.models.length > 0));
      })
      .catch(() => { if (!cancelled) setModelGroups([]); });
    return () => { cancelled = true; };
  }, []);

  const effectiveAgentId = selectedAgentId ?? projectAgentId ?? agents[0]?.id ?? null;
  const effectiveAgent = agents.find(a => a.id === effectiveAgentId) ?? null;
  /** Model shown/used: explicit pick, else the selected agent's primary. */
  const effectiveModel = selectedModel ?? effectiveAgent?.model ?? null;

  // Switching agent resets the model to that agent's primary (unless the user
  // had explicitly picked a model — then keep it; the backend still honors it).
  const handleSelectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setAgentMenuOpen(false);
    const next = agents.find(a => a.id === id);
    if (next?.model) setSelectedModel(null); // fall back to the new agent's primary
  }, [agents]);

  const handleSelectModel = useCallback((ref: string) => {
    setSelectedModel(ref);
    setModelMenuOpen(false);
  }, []);

  // Model menu keyword search: filters the provider/model list while typing
  // (case-insensitive match on provider, model id, or display name).
  const [modelSearch, setModelSearch] = useState('');
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const filteredModelGroups = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return modelGroups;
    return modelGroups
      .map(g => ({
        provider: g.provider,
        models: g.models.filter(
          m =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            g.provider.toLowerCase().includes(q),
        ),
      }))
      .filter(g => g.models.length > 0);
  }, [modelGroups, modelSearch]);
  /** First match in filtered order — selected by Enter in the search box. */
  const firstFilteredModelRef = useMemo(() => {
    for (const g of filteredModelGroups) {
      for (const m of g.models) {
        return `${g.provider}/${m.id}`;
      }
    }
    return null;
  }, [filteredModelGroups]);

  // Fresh search on every menu open; focus the search box for typing.
  useEffect(() => {
    if (modelMenuOpen) {
      setModelSearch('');
      requestAnimationFrame(() => modelSearchRef.current?.focus());
    }
  }, [modelMenuOpen]);

  // Close either selector when clicking outside it.
  useEffect(() => {
    if (!agentMenuOpen && !modelMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (selectorRef.current?.contains(e.target as Node)) return;
      setAgentMenuOpen(false);
      setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [agentMenuOpen, modelMenuOpen]);

  // ── Slash command palette ──
  // Open state is only used for the explicit "/" button — typing "/" as the
  // whole input auto-activates the palette via slashTokenMatch below.
  const [slashOpen, setSlashOpen] = useState(false);
  // Set on blur / Escape / send — suppresses the palette until the input
  // changes again or the textarea regains focus.
  const [slashHidden, setSlashHidden] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skills, setSkills] = useState<Array<{ slug: string; name: string; description: string }>>([]);
  const slashListRef = useRef<HTMLDivElement>(null);
  // Palette opening direction + pixel max-height, measured from the textarea:
  // the palette opens toward whichever side has more room (downward in
  // centered mode, upward when docked at the bottom) and is capped to that
  // side's space so its bottom edge (border included) never falls off-screen
  // — where the last commands would be unreachable even by scrolling.
  const [slashUp, setSlashUp] = useState(false);
  const [slashMaxH, setSlashMaxH] = useState<number | null>(null);
  const slashBtnRef = useRef<HTMLButtonElement>(null);

  // Load available skills once so they can be offered as /skill-id commands.
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ skills: Array<{ slug: string; name: string; description: string }> }>('/api/skills')
      .then(data => { if (!cancelled) setSkills(data?.skills ?? []); })
      .catch(() => { /* skills list is optional — ignore failures */ });
    return () => { cancelled = true; };
  }, []);

  // Save/restore input and file uploads when sessionId changes
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    const cur = sessionId;
    if (prev !== cur) {
      // Save current state for the previous session
      if (prev) {
        inputCacheRef.current.set(prev, input);
        fileUploadsCacheRef.current.set(prev, fileUploads);
      }
      // Restore cached state for the new session (or empty)
      const cachedInput = cur ? (inputCacheRef.current.get(cur) ?? '') : '';
      const cachedUploads = cur ? (fileUploadsCacheRef.current.get(cur) ?? []) : [];
      setInput(cachedInput);
      setFileUploads(cachedUploads);
      prevSessionIdRef.current = cur;
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the per-session file uploads cache up to date on every change
  useEffect(() => {
    if (sessionId) {
      fileUploadsCacheRef.current.set(sessionId, fileUploads);
    }
  }, [fileUploads, sessionId]);

  // Keep the per-session input cache up to date on every keystroke.
  // Complement to the session-switch effect above: ensures the cache is
  // always current so switching back restores the exact typed text even if
  // the session-switch effect's closure captured a stale value.
  useEffect(() => {
    if (sessionId) {
      inputCacheRef.current.set(sessionId, input);
    }
  }, [input, sessionId]);

  // Reset the streaming state machine when switching sessions.
  // This component is NOT remounted on route param changes (same Route
  // position in the tree), so without this, a stream left running in
  // session A keeps sending=true here — and sends in session B get
  // hijacked into steer mode (no new SSE connection, no turn_start,
  // no thinking indicator, no reply). Abort A's SSE and reset all refs;
  // the agent keeps running server-side and the WS agent_turn_complete
  // push refreshes A's history when the user returns.
  const streamSessionResetRef = useRef(sessionId);
  useEffect(() => {
    if (streamSessionResetRef.current === sessionId) return;
    streamSessionResetRef.current = sessionId;
    abortRef.current?.abort();
    abortRef.current = null;
    if (deltaFlushTimerRef.current) {
      clearTimeout(deltaFlushTimerRef.current);
      deltaFlushTimerRef.current = null;
    }
    assistantIdRef.current = '';
    assistantContentRef.current = '';
    assistantCreatedAtRef.current = '';
    toolCallsRef.current = [];
    runningToolsRef.current.clear();
    segmentsRef.current = [];
    flushedCleanLenRef.current = 0;
    steerBubbleRef.current = false;
    approvalMessagesRef.current.clear();
    questionMessagesRef.current.clear();
    activeTurnsRef.current = 0;
    lastSseEventRef.current = Date.now();
    autoSentRef.current = false;
    setSending(false);
  }, [sessionId]);

  /** Start a fresh turn — new assistant message bubble for this response. */
  const beginTurn = () => {
    const newId = uid();
    devLog('[ChatInput] beginTurn', { newId: newId.slice(0, 8), prevId: assistantIdRef.current.slice(0, 8), activeTurns: activeTurnsRef.current + 1 });
    assistantIdRef.current = newId;
    assistantContentRef.current = '';
    assistantCreatedAtRef.current = new Date().toISOString();
    toolCallsRef.current = [];
    segmentsRef.current = [];
    flushedCleanLenRef.current = 0;
    // NOTE: runningToolsRef and approvalMessagesRef are intentionally NOT
    // cleared here. beginTurn is called on both the initial SSE and
    // steer/follow-up, and clearing them would cause tool_call_end and
    // approval_resolved events arriving after steer to be silently dropped.
    activeTurnsRef.current++;
  };

  /** End the current turn. Returns true if this was the last active turn. */
  const endTurn = () => {
    activeTurnsRef.current--;
    if (activeTurnsRef.current <= 0) {
      activeTurnsRef.current = 0;
      return true;
    }
    return false;
  };

  /** Upload a single file to the server. */
  const uploadFile = useCallback(async (item: FileUploadItem): Promise<FileUploadItem> => {
    const formData = new FormData();
    formData.append('file', item.file, item.file.name);
    const token = getToken();
    try {
      const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Upload failed' }));
        return { ...item, status: 'error', error: err.error || 'Upload failed' };
      }
      const data = await response.json() as { ok: boolean; path: string; size: number };
      return { ...item, status: 'done', path: data.path, size: data.size };
    } catch (err) {
      return { ...item, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' };
    }
  }, []);

  /** Process selected files: add to upload list and upload each. */
  const handleFilesSelected = useCallback(async (files: FileList | File[]) => {
    const items: FileUploadItem[] = Array.from(files).map(f => ({
      id: uid(),
      file: f,
      status: 'pending' as const,
    }));
    setFileUploads(prev => [...prev, ...items]);
    // Upload in parallel
    const results = await Promise.all(items.map(item => uploadFile(item)));
    setFileUploads(prev => {
      const updated = [...prev];
      for (const result of results) {
        const idx = updated.findIndex(u => u.id === result.id);
        if (idx >= 0) updated[idx] = result;
      }
      return updated;
    });
  }, [uploadFile]);

  const removeFileUpload = useCallback((id: string) => {
    setFileUploads(prev => {
      const item = prev.find(u => u.id === id);
      // Delete already-uploaded file from server so orphan files don't accumulate
      if (item?.status === 'done' && item.path) {
        const token = getToken();
        fetch('/api/files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ path: item.path }),
        }).catch(() => { /* best effort */ });
      }
      return prev.filter(u => u.id !== id);
    });
  }, []);

  const retryFileUpload = useCallback(async (id: string) => {
    // Read the latest item from the render-time mirror — no side effects
    // inside state updaters (StrictMode would run them twice).
    const item = fileUploadsRef.current.find(u => u.id === id);
    if (!item || item.status === 'uploading') return;
    setFileUploads(prev => prev.map(u => u.id === id ? { ...u, status: 'uploading' as const, error: undefined } : u));
    const result = await uploadFile({ ...item, status: 'uploading' });
    setFileUploads(prev => prev.map(u => u.id === id ? result : u));
  }, [uploadFile]);

  /** Build file reference text and files array from uploaded files for the message.
   *  Returns markdown refs (for the agent) and a structured files array (for the UI). */
  const buildFileRefs = useCallback((uploads: FileUploadItem[]): { refs: string; files: MessageFile[] } => {
    let refs = '';
    const files: MessageFile[] = [];
    for (const f of uploads) {
      if (f.status !== 'done' || !f.path) continue;
      const serveUrl = `/api/files/serve?path=${encodeURIComponent(f.path)}`;
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(f.file.name);
      if (isImage) {
        refs += `\n![${f.file.name}](${serveUrl})`;
      } else {
        refs += `\n[${f.file.name}](${serveUrl})`;
      }
      files.push({ name: f.file.name, path: serveUrl, size: f.size ?? f.file.size });
    }
    return { refs, files };
  }, []);

  const sendMessage = useCallback((messageText: string, opts?: { preserveContent?: boolean }) => {
    if (!messageText.trim() || !projectId || !sessionId) return;
    abortRef.current?.abort();
    setSending(true);
    // Don't clear existing streaming content when sending slash commands
    // during an active stream (e.g. /steer, /btw). Regular sends always reset.
    if (!opts?.preserveContent) {
      onStreamStart?.();
    }

    // Append uploaded file references to the message
    const doneUploads = fileUploads.filter(u => u.status === 'done' && u.path);
    const { refs: fileRefs, files: uploadedFiles } = buildFileRefs(doneUploads);
    const fullContent = (messageText.trim() + fileRefs).trim();

    // Clear input and file uploads FIRST
    setInput('');
    setFileUploads([]);

    const userMessage: Message = {
      // Reuse this id as clientMsgId so the server persists the user message
      // under the SAME id — enables exact dedupe when the post-turn refetch
      // returns the persisted copy.
      id: uid(),
      session_id: sessionId,
      role: 'user',
      content: fullContent,
      ...(uploadedFiles.length > 0 ? { files: uploadedFiles } : {}),
      created_at: new Date().toISOString(),
    };
    if (onMessages) onMessages([userMessage], true); // clearPrevious: new SSE connection

    // First turn is started by the turn_start SSE event (dispatcher.onStart),
    // so we don't call beginTurn() here — doing so would double-count turns
    // and prevent the done handler from resetting the sending state.

    const streamStartTime = Date.now();

    // Trailing-flush throttle state for text_delta updates.
    let lastDeltaFlushTs = 0;
    const cancelPendingDeltaFlush = () => {
      if (deltaFlushTimerRef.current) {
        clearTimeout(deltaFlushTimerRef.current);
        deltaFlushTimerRef.current = null;
      }
    };
    devLog('[ChatInput] SSE stream starting', { sessionId, messagePreview: messageText.slice(0, 40) });

    // ── Assistant bubble update helpers ──
    // Strip reasoning blocks from the accumulated raw content.
    const cleanAssistantContent = () =>
      assistantContentRef.current
        .replace(/<思考>[^]*?<\/思考>/g, '')
        .replace(/<thinking>[^]*?<\/thinking>/gi, '');
    const buildAssistantMessage = (extra?: Partial<Message>): Message => ({
      id: assistantIdRef.current, session_id: sessionId, role: 'assistant',
      content: assistantContentRef.current,
      tool_calls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
      segments: [...segmentsRef.current],
      created_at: assistantCreatedAtRef.current,
      ...extra,
    });
    const emitAssistantUpdate = () => {
      const cleaned = cleanAssistantContent();
      // Only the portion after the last flush point belongs to the
      // current text segment (text after the most recent tool call).
      const currentText = cleaned.slice(flushedCleanLenRef.current);
      const lastSeg = segmentsRef.current[segmentsRef.current.length - 1];
      if (lastSeg?.type === 'text') {
        lastSeg.content = currentText;
      } else if (currentText) {
        segmentsRef.current.push({ type: 'text', content: currentText });
      }
      if (onMessages) {
        onMessages([buildAssistantMessage({ content: cleaned })]);
      }
    };

    abortRef.current = sseClient.start(
      `/api/projects/${projectId}/chat`,
      { sessionId, message: userMessage.content, clientMsgId: userMessage.id, agentId: effectiveAgentId ?? undefined, model: effectiveModel ?? undefined },
      (event: SSEEvent) => {
        devLog('[ChatInput] SSE event', { type: event.type, ts: Date.now() - streamStartTime });
        switch (event.type) {
          case 'turn_start':
            // Gateway received the message — start "thinking" indicator.
            onThinkingChange?.(true);
            // Reuse the bubble eagerly created by steerMessage.
            if (steerBubbleRef.current) {
              steerBubbleRef.current = false;
              activeTurnsRef.current = 1;
            } else {
              beginTurn();
            }
            break;

          case 'skill_activated': {
            // Stop the "thinking" indicator — skill activation is a response
            onThinkingChange?.(false);
            const skillName = event.data || '';
            if (skillName) {
              segmentsRef.current.push({ type: 'skill', name: skillName });
              cancelPendingDeltaFlush();
              emitAssistantUpdate();
            }
            break;
          }

          case 'text_delta': {
            assistantContentRef.current += event.data || '';
            // Stop the "thinking" indicator once the assistant starts responding
            onThinkingChange?.(false);
            {
              // Throttle React updates to ~20fps — every update re-renders and
              // re-parses the full markdown of the active bubble, which gets
              // expensive on long replies. The trailing timer guarantees the
              // final delta always renders.
              const now = Date.now();
              if (now - lastDeltaFlushTs >= DELTA_FLUSH_INTERVAL_MS) {
                lastDeltaFlushTs = now;
                emitAssistantUpdate();
              } else if (!deltaFlushTimerRef.current) {
                deltaFlushTimerRef.current = setTimeout(() => {
                  deltaFlushTimerRef.current = null;
                  lastDeltaFlushTs = Date.now();
                  emitAssistantUpdate();
                }, DELTA_FLUSH_INTERVAL_MS);
              }
            }
            break;
          }

          case 'tool_call_start': {
            // Stop the "thinking" indicator since the assistant is now acting
            onThinkingChange?.(false);
            cancelPendingDeltaFlush();
            const tc: ToolCall = {
              id: event.toolCallId || uid(),
              name: event.toolName || 'unknown',
              // Malformed JSON args must not throw here — an exception would
              // propagate through the SSE reader loop and kill the stream.
              arguments: (() => {
                try {
                  return (typeof event.data === 'string' ? JSON.parse(event.data) : event.data) || {};
                } catch {
                  return { _raw: event.data };
                }
              })(),
              status: 'running',
            };
            runningToolsRef.current.set(tc.id, tc);
            toolCallsRef.current.push(tc);
            // Flush current cleaned text so the next text_delta starts a
            // fresh text segment after this tool call.
            flushedCleanLenRef.current = cleanAssistantContent().length;
            segmentsRef.current.push({ type: 'tool_call', toolCall: tc });
            emitAssistantUpdate();
            break;
          }

          case 'tool_call_end': {
            const toolCallId = event.toolCallId;
            const existing = toolCallId ? runningToolsRef.current.get(toolCallId) : undefined;
            if (existing && toolCallId) {
              existing.status = event.isError ? 'error' : 'success';
              existing.output = event.data ?? '';
              runningToolsRef.current.delete(toolCallId);
            }
            cancelPendingDeltaFlush();
            // Update the matching segment so the tool card re-renders
            // with the final status / output.
            if (existing) {
              for (let i = segmentsRef.current.length - 1; i >= 0; i--) {
                const seg = segmentsRef.current[i]!;
                if (seg.type === 'tool_call' && seg.toolCall?.id === toolCallId) {
                  seg.toolCall = { ...existing };
                  // Immediately extract media from webui_send_media / computer_use
                  // (send_screenshot) output for inline display
                  if ((existing.name === 'webui_send_media' || existing.name === 'computer_use') && existing.status === 'success' && existing.output) {
                    const output = existing.output;
                    // Match both /api/files/serve?path=... and /dl/<token>/<filename> URLs
                    // Use [^\[\]] (exclude both [ and ]) instead of [^\]] to prevent
                    // greedy matching from JSON array brackets like [{...}] in the output.
                    const imgMatch = output.match(/!\[([^\[\]]*)\]\((\/(?:api\/files\/serve\?path=[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/);
                    const linkMatch = !imgMatch && output.match(/\[([^\[\]]+)\]\((\/(?:api\/files\/serve\?path=[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/);
                    const match = imgMatch || linkMatch;
                    if (match) {
                      const alt = match[1] || '';
                      const serveUrl = match[2];
                      const fileName = (() => {
                        try {
                          if (serveUrl.startsWith('/dl/')) {
                            return decodeURIComponent(serveUrl.split('/').pop() || alt);
                          }
                          const params = new URLSearchParams(new URL(serveUrl, window.location.origin).search);
                          const p = params.get('path') || '';
                          return decodeURIComponent(p).split('/').pop() || alt;
                        } catch { return alt; }
                      })();
                      const isImage = !!imgMatch;
                      const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(fileName);
                      const mediaSegment: MessageSegment = {
                        type: 'media',
                        media: {
                          url: serveUrl,
                          alt: alt || fileName,
                          name: fileName,
                          type: isVideo ? 'video' : (isImage ? 'image' : 'file'),
                        },
                      };
                      // Insert media segment right after the tool_call segment
                      segmentsRef.current.splice(i + 1, 0, mediaSegment);
                    }
                  }
                  break;
                }
              }
            }
            emitAssistantUpdate();
            break;
          }

          case 'approval_required': {
            const approvalData: MessageApproval = {
              approvalId: event.approvalId || '',
              command: event.command || event.toolName || '',
              risk: event.risk || 'medium',
              reason: event.reason,
              status: 'pending',
            };
            const approvalMsg: Message = {
              id: `approval-${approvalData.approvalId}`,
              session_id: sessionId,
              role: 'assistant',
              content: '',
              approval: approvalData,
              created_at: new Date().toISOString(),
            };
            approvalMessagesRef.current.set(approvalData.approvalId, approvalMsg);
            if (onMessages) onMessages([approvalMsg]);
            break;
          }

          case 'approval_resolved': {
            const aid = event.approvalId || '';
            const existing = approvalMessagesRef.current.get(aid);
            if (existing && existing.approval) {
              const resolved: Message = {
                ...existing,
                approval: {
                  ...existing.approval,
                  status: (event.decision || '').startsWith('approve') ? 'approved' : 'rejected',
                  decision: event.decision,
                  timeoutReason: event.reason || existing.approval.timeoutReason,
                },
              };
              approvalMessagesRef.current.set(aid, resolved);
              if (onMessages) onMessages([resolved]);
            }
            break;
          }

          case 'user_question': {
            const questionData: UserQuestion = {
              requestId: event.requestId || '',
              question: event.question || '',
              options: event.options || [],
              status: 'pending',
            };
            const questionMsg: Message = {
              id: `question-${questionData.requestId}`,
              session_id: sessionId,
              role: 'assistant',
              content: '',
              userQuestion: questionData,
              created_at: new Date().toISOString(),
            };
            questionMessagesRef.current.set(questionData.requestId, questionMsg);
            if (onMessages) onMessages([questionMsg]);
            break;
          }

          case 'user_question_resolved': {
            const qid = event.requestId || '';
            const existing = questionMessagesRef.current.get(qid);
            if (existing && existing.userQuestion) {
              const resolved: Message = {
                ...existing,
                userQuestion: {
                  ...existing.userQuestion,
                  status: 'answered',
                  answer: event.answer,
                },
              };
              questionMessagesRef.current.set(qid, resolved);
              if (onMessages) onMessages([resolved]);
            }
            break;
          }

          case 'harness_improvement': {
            if (!event.proposal) break;
            const proposalMsg: Message = {
              id: `harness-${event.proposal.id}`,
              session_id: sessionId,
              role: 'assistant',
              content: '',
              harnessImprovement: event.proposal,
              created_at: new Date().toISOString(),
            };
            if (onMessages) onMessages([proposalMsg]);
            break;
          }

          case 'thinking':
            // Reasoning content is deliberately suppressed in WebUI.
            break;

          case 'done': {
            cancelPendingDeltaFlush();
            const footer = (event as any).footer as MessageFooter | undefined;
            // Extract images from markdown in content and tool outputs
            const images: { url: string; alt?: string }[] = [];
            const imgRegex = /!\[([^\[\]]*)\]\(([^)\s]+)\)/g;
            let imgMatch: RegExpExecArray | null;
            const extractImages = (text: string) => {
              imgRegex.lastIndex = 0;
              while ((imgMatch = imgRegex.exec(text)) !== null) {
                const url = imgMatch[2];
                // Only locally-served chat media renders as images — arbitrary
                // external URLs (e.g. from web_search snippets) must not flood
                // the chat with image bubbles.
                if (isChatMediaUrl(url)) {
                  images.push({ alt: imgMatch[1] || undefined, url });
                }
              }
            };
            extractImages(assistantContentRef.current);
            for (const tc of toolCallsRef.current) {
              // Only media-emitting tools may surface images in chat.
              if (tc.status === 'success' && tc.output && CHAT_MEDIA_TOOL_NAMES.has(tc.name)) {
                extractImages(tc.output);
              }
            }
            if (images.length > 0) devLog('[ChatInput] done — extracted images', images.length, images.map(i => i.url.slice(0, 50)));
            // Extract file download links
            const files: { name: string; path: string; size?: number }[] = [];
            const seenFiles = new Set<string>();
            // Use [^\[\]]+ to avoid greedy match from JSON array brackets in tool output
            const linkRegex = /\[([^\[\]]+)\]\((\/(?:api\/files\/(?:serve|download)\?[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/g;
            let linkMatch: RegExpExecArray | null;
            while ((linkMatch = linkRegex.exec(assistantContentRef.current)) !== null) {
              const label = linkMatch[1].trim();
              const url = linkMatch[2];
              if (!seenFiles.has(url)) {
                seenFiles.add(url);
                files.push({ name: label, path: url });
              }
            }
            // Also scan tool call outputs for file links
            for (const tc of toolCallsRef.current) {
              if (tc.status === 'success' && tc.output) {
                linkRegex.lastIndex = 0;
                while ((linkMatch = linkRegex.exec(tc.output)) !== null) {
                  const url = linkMatch[2];
                  if (!seenFiles.has(url)) {
                    seenFiles.add(url);
                    files.push({ name: linkMatch[1].trim(), path: url });
                  }
                }
              }
            }
            // Deduplicate: remove images/files already shown as inline media segments
            const mediaUrls = new Set<string>();
            for (const seg of segmentsRef.current) {
              if (seg.type === 'media' && seg.media?.url) {
                mediaUrls.add(seg.media.url);
              }
            }
            const dedupedImages = mediaUrls.size > 0
              ? images.filter(img => !mediaUrls.has(img.url))
              : images;
            const dedupedFiles = mediaUrls.size > 0
              ? files.filter(f => !mediaUrls.has(f.path))
              : files;
            if (onMessages) {
              onMessages([buildAssistantMessage({
                content: assistantContentRef.current,
                footer: footer || undefined,
                images: dedupedImages.length > 0 ? dedupedImages : undefined,
                files: dedupedFiles.length > 0 ? dedupedFiles : undefined,
                // Keep the original creation time so this bubble stays in
                // its correct chronological position relative to user messages.
                created_at: assistantCreatedAtRef.current || new Date().toISOString(),
              })]);
            }
            // The server persisted this turn's content BEFORE dispatching done
            // (pre-complete callback) — mark the bubble so the parent can prune
            // it once its refetch returns the persisted copy.
            if (assistantIdRef.current) onTurnPersisted?.(assistantIdRef.current);
            // Only set sending=false when ALL turns have completed.
            devLog('[ChatInput] done — endTurn', { activeTurns: activeTurnsRef.current });
            if (endTurn()) {
              devLog('[ChatInput] done — last turn, sending=false');
              setSending(false);
              onDone?.();
            }
            break;
          }

          case 'error': {
            cancelPendingDeltaFlush();
            // Reset everything on stream error
            activeTurnsRef.current = 0;
            setSending(false);
            onDone?.();
            const errorText = event.error || '';
            // NOTE: deliberately NOT marking this bubble as persisted here.
            // The EventBridge error path persists first, but the route-level
            // catch path (execute() threw) sends 'error' WITHOUT persisting —
            // marking then would let the post-error refetch delete an
            // unpersisted bubble. The conservative fuzzy match in
            // ChatView.handleRefetched covers the persisted case instead.
            // Surface the provider/stream error on the current bubble so the
            // task does not appear to "stop by itself" without explanation.
            // User-initiated stops arrive as "Aborted" — that's expected, not
            // an error worth stamping onto the bubble.
            if (errorText && errorText !== 'Aborted' && assistantCreatedAtRef.current && onMessages) {
              onMessages([{
                id: assistantIdRef.current,
                session_id: sessionId,
                role: 'assistant',
                content: assistantContentRef.current,
                tool_calls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                segments: [...segmentsRef.current],
                error: errorText,
                created_at: assistantCreatedAtRef.current || new Date().toISOString(),
              }]);
            }
            break;
          }
        }
      },
      () => {
        // Stream-level failure (network drop, HTTP error, heartbeat timeout).
        cancelPendingDeltaFlush();
        activeTurnsRef.current = 0;
        setSending(false);
        onDone?.();
      },
      // Heartbeat: feed the no-event watchdog from the RAW read loop so the
      // server's ": ping" keepalive comments count too. Without this, long
      // silent phases (running tools, approval/question waits) would trip the
      // 60s timeout and kill the UI stream mid-turn.
      () => { lastSseEventRef.current = Date.now(); },
    );
  }, [projectId, sessionId, onMessages, onStreamStart, onDone, onTurnPersisted, fileUploads, buildFileRefs, effectiveAgentId, effectiveModel]);

  /** Send a steer message while the agent is already running. Does NOT abort
   *  the existing SSE — the steer response streams through the same connection. */
  const steerMessage = useCallback(async (messageText: string) => {
    if (!messageText.trim() || !projectId || !sessionId) return;

    devLog('[ChatInput] steerMessage — queueing steer', { msg: messageText.slice(0, 30), activeTurns: activeTurnsRef.current });

    // Signal that a new stream of output is starting (for the steer response).
    onStreamStart?.();

    // The original turn was interrupted by this steer — its 'done' event
    // may never arrive. Reset the turn counter so the steer turn's 'done'
    // can properly set sending=false. beginTurn() increments to 1, and
    // the steer turn's 'done' will decrement it back to 0.
    activeTurnsRef.current = 0;
    beginTurn();
    steerBubbleRef.current = true;

    // Append uploaded file references and clear input / uploads
    const doneUploads = fileUploads.filter(u => u.status === 'done' && u.path);
    const { refs: fileRefs, files: uploadedFiles } = buildFileRefs(doneUploads);
    const fullContent = (messageText.trim() + fileRefs).trim();
    setInput('');
    setFileUploads([]);

    const userMessage: Message = {
      id: uid(),
      session_id: sessionId,
      role: 'user',
      content: fullContent,
      ...(uploadedFiles.length > 0 ? { files: uploadedFiles } : {}),
      created_at: new Date().toISOString(),
    };
    if (onMessages) onMessages([userMessage], false); // clearPrevious: false — keep current-turn messages

    // Send steer request (non-blocking — the existing SSE handles the response)
    const token = getToken();
    try {
      await fetch(`/api/projects/${projectId}/chat/steer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionId, message: fullContent }),
      });
    } catch {
      // Steer is best-effort; the existing SSE continues regardless
    }
  }, [projectId, sessionId, onMessages, fileUploads, buildFileRefs]);

  /** Send a slash command while the agent is already running.
   *  Routes through POST /chat/steer so the RUNNING SSE connection is NOT
   *  aborted — previously this path opened a second SSE which killed the
   *  active stream's UI while the agent kept running server-side. The
   *  command reply (when the command completes synchronously) is rendered
   *  locally; steered/forwarded commands respond via the existing stream. */
  const sendCommandViaSteer = useCallback(async (messageText: string) => {
    if (!messageText.trim() || !projectId || !sessionId) return;
    setInput('');
    // Local echo of the command itself — the steer endpoint does not persist
    // command messages, so without this the user's input would vanish from
    // the conversation view.
    if (onMessages) {
      onMessages([{
        id: uid(),
        session_id: sessionId,
        role: 'user',
        content: messageText,
        created_at: new Date().toISOString(),
      }], false);
    }
    try {
      const data = await apiRequest<{ ok: boolean; reply?: string }>(
        `/api/projects/${projectId}/chat/steer`,
        { method: 'POST', body: JSON.stringify({ sessionId, message: messageText }) },
      );
      if (data?.reply && onMessages) {
        onMessages([{
          id: uid(),
          session_id: sessionId,
          role: 'assistant',
          content: data.reply,
          created_at: new Date().toISOString(),
        }], false);
      }
    } catch (err) {
      console.warn('[ChatInput] command via steer failed:', err);
    }
  }, [projectId, sessionId, onMessages]);

  const handleSend = useCallback(() => {
    const text = textareaRef.current?.value ?? input;
    const hasFiles = fileUploads.some(u => u.status === 'done');
    if (!text.trim() && !hasFiles) return;
    setSlashOpen(false);
    setSlashHidden(true);
    if (!sessionId) {
      // No session yet — hand the text to the parent which creates a session
      // and navigates; the text is auto-sent as the first message afterwards.
      if (onQuickStart && text.trim()) {
        setInput('');
        onQuickStart(text);
      }
      return;
    }
    if (sending) {
      // Agent is running — never open a second SSE; route everything
      // through the existing stream's steer channel.
      if (text.startsWith('/')) {
        sendCommandViaSteer(text);
      } else {
        steerMessage(text);
      }
    } else {
      sendMessage(text);
    }
  }, [input, sendMessage, sending, steerMessage, sendCommandViaSteer, fileUploads, sessionId, onQuickStart]);

  // Auto-send initial message from navigation state (session was just created)
  useEffect(() => {
    if (autoSentRef.current) return;
    const state = location.state as { initialMessage?: string } | null;
    if (state?.initialMessage && projectId && sessionId) {
      autoSentRef.current = true;
      window.history.replaceState({}, '');
      sendMessage(state.initialMessage);
    }
  }, [projectId, sessionId, sendMessage, location.state]);

  // Abort SSE stream on unmount — prevents stale connections from
  // leaking messages into a different conversation after a session switch.
  useEffect(() => {
    return () => {
      devLog('[ChatInput] unmounting — aborting SSE stream');
      abortRef.current?.abort();
      if (deltaFlushTimerRef.current) {
        clearTimeout(deltaFlushTimerRef.current);
        deltaFlushTimerRef.current = null;
      }
      activeTurnsRef.current = 0;
      setSending(false);
    };
  }, []);

  // Safety timeout: reset sending state if SSE stream hangs (no events
  // for 60s). Uses a heartbeat ref updated on every SSE event so long-
  // running tools (e.g. image generation) don't trigger a false timeout.
  const lastSseEventRef = useRef(Date.now());
  useEffect(() => {
    if (!sending) return;
    const interval = setInterval(() => {
      if (Date.now() - lastSseEventRef.current > 60_000) {
        console.warn('[ChatInput] SSE heartbeat timeout — no events for 60s');
        abortRef.current?.abort();
        activeTurnsRef.current = 0;
        setSending(false);
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [sending]);

  // ── Slash command palette logic ──
  // Built-in commands and skill commands are two separate groups: the
  // dropdown renders them under their own section headers, each sorted A-Z.
  // NOTE: skills are inserted as "/skill:<slug>" — the backend skill router
  // only recognizes "/skill:<slug>" (start of message) or "$<slug>" (anywhere).
  const builtInCommands = useMemo<SlashCommand[]>(() => [
    { id: 'agents', description: t('chat.slash.agents') },
    { id: 'btw', description: t('chat.slash.btw') },
    { id: 'clear', description: t('chat.slash.clear') },
    { id: 'cron', description: t('chat.slash.cron') },
    { id: 'extension', description: t('chat.slash.extension') },
    { id: 'new', description: t('chat.slash.new') },
    { id: 'permission', description: t('chat.slash.permission') },
    { id: 'queue', description: t('chat.slash.queue') },
    { id: 'skills', description: t('chat.slash.skills') },
    { id: 'steer', description: t('chat.slash.steer') },
    { id: 'stop', description: t('chat.slash.stop') },
    { id: 'team', description: t('chat.slash.team') },
  ], [t]);

  const skillCommands = useMemo<SlashCommand[]>(() => skills.map(s => ({
    id: `skill:${s.slug}`,
    name: s.name,
    description: s.description || t('chat.slash.skillDefault'),
    skill: true,
  })), [skills, t]);

  // The palette is active when the whole input is exactly "/token" (typing a
  // command, no space yet) or when the user opened it via the "/" button with
  // an empty input. Once args are typed (space) it hides so Enter sends normally.
  const slashTokenMatch = /^\/([^\s/]*)$/.exec(input);
  const slashQuery = slashTokenMatch ? slashTokenMatch[1] : (slashOpen && input === '' ? '' : null);
  const slashActive = slashQuery !== null;

  const matchesSlashQuery = useCallback((c: SlashCommand, q: string) =>
    c.id.toLowerCase().includes(q) ||
    (c.name ?? '').toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q), []);

  const filteredCommands = useMemo(() => {
    const q = (slashQuery ?? '').trim().toLowerCase();
    return builtInCommands
      .filter(c => !q || matchesSlashQuery(c, q))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
  }, [builtInCommands, slashQuery, matchesSlashQuery]);

  const filteredSkillCommands = useMemo(() => {
    const q = (slashQuery ?? '').trim().toLowerCase();
    return skillCommands
      .filter(c => !q || matchesSlashQuery(c, q))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
  }, [skillCommands, slashQuery, matchesSlashQuery]);

  /** Flat list for keyboard navigation: commands first, then skills. */
  const filteredSlash = useMemo(
    () => [...filteredCommands, ...filteredSkillCommands],
    [filteredCommands, filteredSkillCommands],
  );

  const slashVisible = slashActive && !slashHidden && filteredSlash.length > 0;

  // Reset the highlight whenever the filtered list content changes.
  useEffect(() => { setSlashIndex(0); }, [slashQuery, slashActive]);

  // Drop the attachment button's active style when the native file dialog
  // closes — the dialog blurs the window while open, and focus fires on close.
  // The input's 'cancel' event (dismiss without picking) also clears it.
  useEffect(() => {
    if (!attachActive) return;
    const clear = () => setAttachActive(false);
    window.addEventListener('focus', clear);
    fileInputRef.current?.addEventListener('cancel', clear);
    return () => {
      window.removeEventListener('focus', clear);
      fileInputRef.current?.removeEventListener('cancel', clear);
    };
  }, [attachActive]);

  // Keep the highlighted item visible while navigating with arrow keys.
  useEffect(() => {
    slashListRef.current
      ?.querySelector(`[data-slash-idx="${slashIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, filteredSlash.length, slashVisible]);

  // Measure the space above/below the palette anchor (the wrapper around the
  // textarea — NOT the textarea itself: the inline-block descender gap makes
  // the wrapper a few px taller, which used to push the palette's bottom edge
  // off-screen on short viewports).
  useEffect(() => {
    if (!slashVisible) { setSlashMaxH(null); return; }
    const compute = () => {
      const anchor = textareaRef.current?.parentElement;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12; // top margin (mt-2) + slack
      const above = rect.top - 12;                         // bottom margin (mb-2) + slack
      // Prefer downward; flip upward only when below is too tight and above has room.
      const up = below < 200 && above > below;
      setSlashUp(up);
      setSlashMaxH(Math.max(96, Math.floor(Math.min(256, up ? above : below))));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [slashVisible]);

  // Close the palette when clicking anywhere outside it, outside the slash
  // button, and outside the textarea (the textarea's blur alone misses clicks
  // on elements that don't take focus, e.g. plain divs).
  useEffect(() => {
    if (!slashVisible) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (slashListRef.current?.contains(t)) return;
      if (slashBtnRef.current?.contains(t)) return; // slash button toggles via its own onClick
      if (textareaRef.current?.contains(t)) return;
      setSlashOpen(false);
      setSlashHidden(true);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [slashVisible]);
  /** Fill the input with the selected command (replacing a leading partial). */
  const applySlash = useCallback((cmd: SlashCommand) => {
    const cur = textareaRef.current?.value ?? input;
    const next = cur.startsWith('/')
      ? cur.replace(/^\/[^\s/]*/, `/${cmd.id} `)
      : (cur ? `/${cmd.id} ${cur}` : `/${cmd.id} `);
    setInput(next);
    setSlashOpen(false);
    setSlashHidden(true);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
      }
    });
  }, [input]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashActive && filteredSlash.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex(i => (i + 1) % filteredSlash.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex(i => (i - 1 + filteredSlash.length) % filteredSlash.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        e.preventDefault();
        applySlash(filteredSlash[Math.min(slashIndex, filteredSlash.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        setSlashHidden(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      setSlashOpen(false);
      setSlashHidden(true);
      handleSend();
    }
  };

  const hasInput = input.trim().length > 0;
  const hasDoneFiles = fileUploads.some(u => u.status === 'done');
  const hasUploading = fileUploads.some(u => u.status === 'uploading');

  /** One row of the slash command dropdown. `idx` is the flat keyboard-nav index. */
  const renderSlashItem = (c: SlashCommand, idx: number) => (
    <button
      key={`${c.skill ? 'skill' : 'cmd'}-${c.id}`}
      type="button"
      data-slash-idx={idx}
      onMouseDown={e => e.preventDefault()}
      onClick={() => applySlash(c)}
      onMouseEnter={() => setSlashIndex(idx)}
      className={`flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors ${
        idx === slashIndex ? 'bg-neutral-100 dark:bg-neutral-800' : ''
      }`}
    >
      <span
        className={`shrink-0 font-mono text-[13px] ${
          c.skill
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-blue-600 dark:text-blue-400'
        }`}
      >
        /{c.id}
      </span>
      <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">
        {c.name ? `${c.name} — ${c.description}` : c.description}
      </span>
    </button>
  );

  return (
    <div
      className={`chat-input-theme relative bg-white dark:bg-neutral-950 ${
        centered
          ? 'flex min-h-0 flex-1 flex-col justify-center px-3 pb-[14vh] sm:px-4'
          /* Bottom padding keeps the input lifted off the page edge (the old
             pb-safe left 0px there); safe-area inset is honored on top of it. */
          : 'shrink-0 px-3 pt-0 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] sm:px-4 sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]'
      } ${isDragOver ? 'ring-2 ring-blue-400 dark:ring-blue-500' : ''}`}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
      onDragEnter={e => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current++;
        if (dragCounterRef.current === 1) setIsDragOver(true);
      }}
      onDragLeave={e => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setIsDragOver(false);
        }
      }}
      onDrop={e => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current = 0;
        setIsDragOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleFilesSelected(e.dataTransfer.files);
        }
      }}
    >
      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-400 bg-blue-50/80 dark:bg-blue-900/40 dark:border-blue-500">
          <p className="text-sm font-medium text-blue-600 dark:text-blue-300">
            {t('chat.input.dragActive')}
          </p>
        </div>
      )}

      {/* File upload chips */}
      {fileUploads.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 max-w-3xl mx-auto w-full">
          {fileUploads.map(item => (
            <div key={item.id}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                item.status === 'error'
                  ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                  : 'border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
              }`}
            >
              {item.status === 'uploading' && <Loader2 size={12} className="animate-spin shrink-0" />}
              {item.status === 'pending' && (
                <svg className="h-3 w-3 shrink-0 animate-pulse text-neutral-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v20M2 12h20" />
                </svg>
              )}
              <span className="truncate max-w-[120px]">{item.file.name}</span>
              {item.status === 'done' && <span className="text-neutral-400 shrink-0">({formatFileSize(item.file.size)})</span>}
              {item.status === 'error' && (
                <>
                  <span className="text-red-500 truncate max-w-[100px]">{item.error || t('chat.input.uploadFailed')}</span>
                  <button onClick={() => retryFileUpload(item.id)}
                    className="underline hover:no-underline shrink-0">{t('chat.input.retry')}</button>
                </>
              )}
              <button onClick={() => removeFileUpload(item.id)}
                className="hover:opacity-70 transition-opacity shrink-0" aria-label={t('chat.input.remove')}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative mx-auto w-full max-w-3xl">
        {/* Welcome header — only shown in centered (new session) mode */}
        {centered && (
          <div className="mb-5 text-center">
            <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800">
              <Bot className="h-7 w-7 text-neutral-400 dark:text-neutral-500" strokeWidth={1.5} />
            </div>
            <h2 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-200">{t('chat.startNew')}</h2>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => { setAttachActive(false); if (e.target.files && e.target.files.length > 0) handleFilesSelected(e.target.files); e.target.value = ''; }}
        />

        {/* Anchor wrapper — the palette and the corner buttons are positioned
            relative to the textarea itself, not the outer column, so the
            palette's bottom edge always hugs the input. */}
        <div className="relative">

        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); setSlashHidden(false); }}
          onKeyDown={handleKeyDown}
          onFocus={() => setSlashHidden(false)}
          onBlur={() => { setSlashOpen(false); setSlashHidden(true); }}
          placeholder={t('chat.input.placeholder')}
          rows={4}
          disabled={!projectId || (!sessionId && !onQuickStart)}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="block w-full resize-none rounded-xl border border-neutral-300 bg-white py-2.5 pl-3 pr-[88px] text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:py-3 sm:pl-4 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-600"
        />

        {/* Slash command palette — opens toward whichever side of the textarea
            has more room (auto-flips when either side is too tight), with its
            height capped to that side so the bottom edge always stays visible.
            Commands and skills render as two A-Z sorted sections. */}
        {slashVisible && (
          <div
            ref={slashListRef}
            style={slashMaxH != null ? { maxHeight: slashMaxH } : undefined}
            className={`absolute right-0 left-0 z-20 max-h-[min(16rem,40vh)] overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 ${
              slashUp ? 'bottom-full mb-2' : 'top-full mt-2'
            }`}
          >
            {filteredCommands.length > 0 && (
              <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t('chat.slash.commandsHeader')}
              </div>
            )}
            {filteredCommands.map((c, i) => renderSlashItem(c, i))}
            {filteredSkillCommands.length > 0 && (
              <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t('chat.slash.skillsHeader')}
              </div>
            )}
            {filteredSkillCommands.map((c, i) => renderSlashItem(c, filteredCommands.length + i))}
          </div>
        )}

        {/* Slash command button — bottom-left inside the textarea (small circle).
            Unified style: no border when idle, blue background + white icon on
            hover. */}
        <button
          ref={slashBtnRef}
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => { setSlashOpen(o => !o); setSlashHidden(false); }}
          disabled={!projectId || (!sessionId && !onQuickStart)}
          aria-label={t('chat.input.slashCommands')}
          title={t('chat.input.slashCommands')}
          className={`absolute bottom-1.5 left-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
            slashActive
              ? 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-white'
              : 'border-transparent text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200'
          }`}
        >
          /
        </button>

        {/* Agent + Model selectors — immediately to the right of the slash
            button, bottom-left inside the textarea. Each opens a compact
            menu; the agent menu lists configured agents (default: the
            session project's default agent) and the model menu lists models
            from configured builtin/custom providers (default: the selected
            agent's primary model). Selections travel in the POST body. */}
        <div ref={selectorRef} className="absolute bottom-1.5 left-9 flex items-center gap-1">
          {/* Agent selector */}
          <div className="relative">
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setAgentMenuOpen(o => !o); setModelMenuOpen(false); }}
              disabled={!projectId || (!sessionId && !onQuickStart) || agents.length === 0}
              aria-label={t('chat.input.agentSelector')}
              title={t('chat.input.agentSelector')}
              className="inline-flex h-6 max-w-[130px] items-center gap-1 rounded-full border border-transparent px-2 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 sm:max-w-[160px]"
            >
              <Bot size={12} className="shrink-0" />
              <span className="truncate">{effectiveAgent?.name ?? t('chat.input.agentDefault')}</span>
              <ChevronDown size={11} className="shrink-0 opacity-60" />
            </button>
            {agentMenuOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
                <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t('chat.input.agentMenuHeader')}
                </div>
                {agents.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => handleSelectAgent(a.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                      a.id === effectiveAgentId ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-200">{a.name}</span>
                    {a.id === effectiveAgentId && <Check size={12} className="shrink-0 text-blue-500" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model selector */}
          <div className="relative">
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setModelMenuOpen(o => !o); setAgentMenuOpen(false); }}
              disabled={!projectId || (!sessionId && !onQuickStart) || modelGroups.length === 0}
              aria-label={t('chat.input.modelSelector')}
              title={t('chat.input.modelSelector')}
              className="inline-flex h-6 max-w-[60vw] items-center gap-1 rounded-full border border-transparent px-2 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 sm:max-w-none"
            >
              <span className="shrink-0 text-[11px] leading-none grayscale">🧠</span>
              <span className="whitespace-nowrap">{effectiveModel ?? t('chat.input.modelDefault')}</span>
              <ChevronDown size={11} className="shrink-0 opacity-60" />
            </button>
            {modelMenuOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
                {/* Keyword search — filters the model list as you type */}
                <div className="sticky top-0 z-10 bg-white px-2 pb-1.5 pt-1.5 dark:bg-neutral-900">
                  <input
                    ref={modelSearchRef}
                    type="text"
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && firstFilteredModelRef) {
                        e.preventDefault();
                        handleSelectModel(firstFilteredModelRef);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setModelMenuOpen(false);
                      }
                    }}
                    placeholder={t('chat.input.modelSearch')}
                    className="w-full rounded-md border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-neutral-600"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto">
                {filteredModelGroups.length === 0 && (
                  <div className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">
                    {t('chat.input.modelSearchNoMatch')}
                  </div>
                )}
                {filteredModelGroups.map(g => (
                  <div key={g.provider}>
                    <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {g.provider}
                    </div>
                    {g.models.map(m => {
                      const ref = `${g.provider}/${m.id}`;
                      return (
                        <button
                          key={ref}
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => handleSelectModel(ref)}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                            ref === effectiveModel ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-200">{m.name}</span>
                          {ref === effectiveModel && <Check size={12} className="shrink-0 text-blue-500" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Corner buttons — bottom-right inside the textarea */}
        <div className="absolute right-1 bottom-1.5 flex items-center gap-1">
          {/* Attachment button — unified style: no border when idle, blue
              background + white icon while the native file-picker dialog is
              open (same active style as the slash button). The dialog steals
              window focus; when it closes, focus returns and we drop the
              active style. */}
          <button
            onClick={() => { if (attachActive) return; setAttachActive(true); fileInputRef.current?.click(); }}
            disabled={!projectId || (!sessionId && !onQuickStart)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
              attachActive
                ? 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-white'
                : 'border-transparent text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-200'
            }`}
            aria-label={t('chat.input.attachFiles')}
            title={t('chat.input.attachFiles')}
          >
            <Paperclip size={16} />
          </button>

          {/* Send button — circular when active (blue background). While the
              agent is running it turns into a stop button (bigger square icon,
              same active-blue background); clicking stops the agent. */}
          {sending && sessionId ? (
            <button
              onClick={() => sendMessage('/stop')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-500 text-white transition-colors hover:bg-blue-600 dark:bg-blue-400 dark:hover:bg-blue-500"
              aria-label={t('chat.slash.stop')}
              title={t('chat.slash.stop')}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => {
                const text = textareaRef.current?.value.trim() || input.trim();
                if (text || hasDoneFiles) {
                  handleSend();
                } else if (sessionId) {
                  sendMessage('/stop');
                }
              }}
              disabled={(!hasInput && !hasDoneFiles && !sending) || !projectId || hasUploading || (!sessionId && !onQuickStart)}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                hasInput || hasDoneFiles
                  ? 'border-blue-500 bg-blue-500 text-white hover:border-blue-600 hover:bg-blue-600 dark:border-blue-400 dark:bg-blue-400 dark:hover:border-blue-500 dark:hover:bg-blue-500'
                  : 'border-transparent text-neutral-400 dark:text-neutral-500'
              }`}
              aria-label={t('chat.send')}
            >
              <Send size={16} />
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
