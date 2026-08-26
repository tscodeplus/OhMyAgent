import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Send, Paperclip, X, Loader2 } from 'lucide-react';
import { createSSEClient, type SSEEvent } from '../../utils/sse-client';
import { apiRequest, getToken } from '../../utils/api';
import { devLog } from '../../utils/logger';
import { CHAT_MEDIA_TOOL_NAMES, isChatMediaUrl } from '../../utils/chatMedia';
import type { Message, MessageApproval, UserQuestion, ToolCall, MessageFooter, MessageSegment, MediaSegmentItem, MessageFile } from '../../types/session';

interface ChatInputProps {
  projectId?: string;
  sessionId?: string;
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

export default function ChatInput({ projectId, sessionId, onMessages, onStreamStart, onThinkingChange, onDone, onTurnPersisted }: ChatInputProps) {
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

  // Per-session cache — preserves input text and file uploads when switching conversations
  const inputCacheRef = useRef<Map<string, string>>(new Map());
  const fileUploadsCacheRef = useRef<Map<string, FileUploadItem[]>>(new Map());
  const prevSessionIdRef = useRef(sessionId);

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
    // Abort any running SSE stream before starting a new one
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
      { sessionId, message: userMessage.content, clientMsgId: userMessage.id },
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
  }, [projectId, sessionId, onMessages, onStreamStart, onDone, onTurnPersisted, fileUploads, buildFileRefs]);

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
  }, [input, sendMessage, sending, steerMessage, sendCommandViaSteer, fileUploads]);

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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasInput = input.trim().length > 0;
  const hasDoneFiles = fileUploads.some(u => u.status === 'done');
  const hasUploading = fileUploads.some(u => u.status === 'uploading');

  return (
    <div
      className={`shrink-0 border-t border-neutral-200 bg-white px-3 sm:px-4 py-2 sm:py-3 dark:border-neutral-800 dark:bg-neutral-950 relative ${
        isDragOver ? 'ring-2 ring-blue-400 dark:ring-blue-500' : ''
      }`}
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
                  : 'border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
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

      <div className="mx-auto max-w-3xl relative">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files && e.target.files.length > 0) handleFilesSelected(e.target.files); e.target.value = ''; }}
        />

        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.input.placeholder')}
          rows={3}
          disabled={!projectId || !sessionId}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full resize-none rounded-xl border border-neutral-300 bg-white px-3 sm:px-4 py-2.5 sm:py-3 pr-[72px] sm:pr-[80px] text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />

        {/* Buttons positioned at bottom-right inside the textarea */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          {/* Attachment button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!projectId || !sessionId}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed dark:text-neutral-500 dark:hover:text-neutral-300 dark:hover:bg-neutral-800 transition-colors"
            aria-label={t('chat.input.attachFiles')}
          >
            <Paperclip size={16} />
          </button>

          {/* Send button */}
          <button
            onClick={() => {
              const text = textareaRef.current?.value.trim() || input.trim();
              if (text || hasDoneFiles) {
                handleSend();
              } else {
                sendMessage('/stop');
              }
            }}
            disabled={(!hasInput && !hasDoneFiles && !sending) || !projectId || !sessionId || hasUploading}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              hasInput || hasDoneFiles
                ? 'bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-400 dark:hover:bg-blue-500'
                : 'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:text-neutral-500 dark:hover:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
            aria-label={t('chat.send')}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
