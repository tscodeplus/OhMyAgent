import { useState, useCallback, useRef, useEffect, useMemo, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import {
  Send,
  Paperclip,
  X,
  Loader2,
  Bot,
  Square,
  ChevronDown,
  Check,
  Brain,
  Settings,
} from 'lucide-react';
import { apiRequest, getToken } from '../../utils/api';
import Toggle from '../ui/Toggle';
import { useSettings } from '../../contexts/SettingsContext';
import { devLog } from '../../utils/logger';
import { useMediaQuery } from '../../utils/useMediaQuery';
import { chatStreamStore } from '../../state/chat-stream-store';
import { useChatSending } from '../../state/useChatStream';
import type { Message, MessageFile } from '../../types/session';

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
  models: Array<{ id: string; name: string; reasoning?: boolean; reasoningLevel?: string }>;
}

/** Full thinking-level set exposed by the reasoning selector (pi-mono
 *  ThinkingLevel + 'off'). Mirrors the server-side validator in chat-routes. */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

export default function ChatInput({
  projectId,
  sessionId,
  centered,
  onQuickStart,
}: ChatInputProps) {
  const { t } = useTranslation('common');
  const { openSettings } = useSettings();
  const location = useLocation();
  const [input, setInput] = useState('');

  // Phones have no Shift key, and `enterKeyHint="send"` already labels the
  // on-screen return key "发送" — so the desktop hint is both misleading and
  // too wide for a phone-width composer once the iOS focus-zoom fix raised the
  // control font-size to 16px. Below md — the same breakpoint the font-size
  // rule uses — show a short one.
  const isCompactViewport = useMediaQuery('(max-width: 768px)');
  // A turn's running state lives in the session-scoped stream store, not in
  // this component: switching sessions must not reset it (the stream keeps
  // running), and the composer only needs the boolean for its send/stop swap.
  const sending = useChatSending(sessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoSentRef = useRef(false);

  // Render-time mirror of fileUploads so retryFileUpload can read the latest
  // item WITHOUT side effects inside a state updater (updaters must stay pure
  // — React StrictMode runs them twice, which would double-upload files).
  const fileUploadsRef = useRef<FileUploadItem[]>([]);

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
  /** Per-turn reasoning level override (null = use the model's effective
   *  default). Kept across turns ("last level the user set"); cleared when the
   *  selected model can't do reasoning at all. */
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<string | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  // Selector menu placement — direction is FIXED upward for both selectors in
  // every mode (matches the pre-existing behavior; downward never happens).
  // The MAX HEIGHT is measured (synchronously on open, re-measured on
  // viewport changes) and capped to the usable space above the input: on
  // phones that's below the mobile topbar (session-title strip) so the panel
  // — search box included — never extends under it and gets clipped; on
  // desktop it's the top of the viewport (no topbar, identical to before).
  const [selectorMenuMaxH, setSelectorMenuMaxH] = useState<number | null>(null);
  const measureSelectorMenus = useCallback((forModel: boolean) => {
    const anchor = selectorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // visualViewport: on phones the address bar expands/collapses and
    // window.innerHeight no longer equals the visible area — visualViewport
    // does (offsetTop = top of the visible area). Identical to innerHeight
    // on desktop.
    const vv = window.visualViewport;
    const vtop = vv?.offsetTop ?? 0;
    const cap = forModel ? 384 : 256; // 24rem / 16rem
    // The mobile top bar sits inside the layout above the chat column, so
    // an upward panel can extend past it and be clipped by the column's
    // overflow — hiding the search box. Account for its bottom edge when
    // sizing: the panel stays below it. Desktop has no such bar (the
    // element is md:hidden → getClientRects() is empty) → falls back to
    // vtop, keeping desktop sizing unchanged.
    const topbar = document.querySelector<HTMLElement>('[data-topbar]');
    const topbarBottom =
      topbar && topbar.getClientRects().length > 0 ? topbar.getBoundingClientRect().bottom : vtop;
    // Space above the selector row (bottom of panel → below the topbar /
    // top of viewport); mb-2 = 8px + 4px slack so the panel never kisses.
    const sideSpace = rect.top - Math.max(vtop, topbarBottom) - 12;
    setSelectorMenuMaxH(Math.max(96, Math.floor(Math.min(cap, sideSpace))));
  }, []);

  // Project's default agent — the agent dropdown's initial value.
  useEffect(() => {
    if (!projectId) {
      setProjectAgentId(null);
      return;
    }
    let cancelled = false;
    apiRequest<{ agent_id?: string }>(`/api/projects/${projectId}`)
      .then((data) => {
        if (!cancelled) setProjectAgentId(data?.agent_id ?? null);
      })
      .catch(() => {
        if (!cancelled) setProjectAgentId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Configured agents list.
  useEffect(() => {
    let cancelled = false;
    apiRequest<AgentOption[]>('/api/agents')
      .then((data) => {
        if (!cancelled) setAgents(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Model catalog grouped by configured provider (builtin with key + custom).
  // Also captures the global defaultReasoningLevel (Model Router tab) so the
  // reasoning selector can display each model's effective default.
  useEffect(() => {
    let cancelled = false;
    apiRequest<{
      providers: Array<{ id: string }>;
      defaultReasoningLevel?: string;
    }>('/api/providers/configured')
      .then(async (data) => {
        const providers = data?.providers ?? [];
        if (!cancelled) setGlobalDefaultReasoningLevel(data?.defaultReasoningLevel ?? null);
        const groups = await Promise.all(
          providers.map(async (p) => {
            try {
              const res = await apiRequest<{
                models: Array<{
                  id: string;
                  name?: string;
                  reasoning?: boolean;
                  reasoningLevel?: string;
                }>;
              }>(`/api/providers/${p.id}/models`);
              return {
                provider: p.id,
                models: (res?.models ?? []).map((m) => ({
                  id: m.id,
                  name: m.name || m.id,
                  reasoning: m.reasoning,
                  reasoningLevel: m.reasoningLevel,
                })),
              };
            } catch {
              return { provider: p.id, models: [] };
            }
          }),
        );
        // Sort providers A-Z, and each provider's models A-Z (by display name).
        const sorted = groups
          .filter((g) => g.models.length > 0)
          .sort((a, b) => a.provider.localeCompare(b.provider, undefined, { sensitivity: 'base' }))
          .map((g) => ({
            ...g,
            models: [...g.models].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
            ),
          }));
        if (!cancelled) setModelGroups(sorted);
      })
      .catch(() => {
        if (!cancelled) setModelGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveAgentId = selectedAgentId ?? projectAgentId ?? agents[0]?.id ?? null;
  const effectiveAgent = agents.find((a) => a.id === effectiveAgentId) ?? null;
  /** Model shown/used: explicit pick, else the selected agent's primary. */
  const effectiveModel = selectedModel ?? effectiveAgent?.model ?? null;

  // ── Reasoning level (per-turn override + effective default) ──
  const [globalDefaultReasoningLevel, setGlobalDefaultReasoningLevel] = useState<string | null>(
    null,
  );
  /** Catalog entry of the model actually in use (for capability gating and the
   *  per-model configured reasoningLevel). */
  const effectiveModelEntry = useMemo(() => {
    if (!effectiveModel) return null;
    const idx = effectiveModel.indexOf('/');
    if (idx === -1) return null;
    const provider = effectiveModel.slice(0, idx);
    const modelId = effectiveModel.slice(idx + 1);
    return (
      modelGroups.find((g) => g.provider === provider)?.models.find((m) => m.id === modelId) ?? null
    );
  }, [effectiveModel, modelGroups]);
  /** Server precedence: per-model config (customProviders) > global
   *  defaultReasoningLevel (Model Router tab) > 'off'. */
  const modelDefaultReasoningLevel =
    effectiveModelEntry?.reasoningLevel ?? globalDefaultReasoningLevel ?? 'off';
  /** Level in effect this turn: user override, else the model's default. */
  const effectiveReasoningLevel = selectedReasoningLevel ?? modelDefaultReasoningLevel;
  /** Hide the selector entirely for models the catalog marks non-reasoning
   *  (unknown entries stay visible — the catalog may simply not list them). */
  const reasoningAvailable = effectiveModelEntry ? effectiveModelEntry.reasoning !== false : true;
  // A level picked for a reasoning model must not leak into a non-reasoning one.
  useEffect(() => {
    if (selectedReasoningLevel && !reasoningAvailable) setSelectedReasoningLevel(null);
  }, [reasoningAvailable, selectedReasoningLevel]);
  /** "深度思考" switch: on = any non-off level is in effect. */
  const depthEnabled = effectiveReasoningLevel !== 'off';
  /** "默认强度" switch: on = the selection still matches the model's default
   *  (no user override). Turning it on restores that default in one click. */
  const followingDefault = selectedReasoningLevel === null;
  const NEUTRAL_LEVEL = 'high'; // used when deep-thinking is switched on with an 'off' default
  const handleToggleDepth = useCallback(
    (on: boolean) => {
      if (!on) {
        setSelectedReasoningLevel('off');
        return;
      }
      // Switching deep thinking on: restore the model's default level when it
      // is non-off, otherwise fall back to a neutral level for the user to
      // refine (the 默认强度 switch shows OFF — this is now an override).
      setSelectedReasoningLevel(modelDefaultReasoningLevel !== 'off' ? null : NEUTRAL_LEVEL);
    },
    [modelDefaultReasoningLevel],
  );
  const handleToggleDefault = useCallback((on: boolean) => {
    // OFF→ON: one-click restore to the model's default. ON→OFF is a no-op —
    // deviating happens through the 深度思考 switch or the level chips.
    if (on) setSelectedReasoningLevel(null);
  }, []);

  // ── Session-pinned selector state ──
  // The server pins the agent / model / reasoning level to the session so the
  // selection survives page reloads and session switches. On a switch BETWEEN
  // sessions the local selectors reset and this session's pins are restored;
  // entering a session from quick-start keeps the user's pre-session picks.
  const loadedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prevSession = prevSessionIdRef.current; // still the previous id here
    if (prevSession !== null && prevSession !== sessionId) {
      setSelectedModel(null);
      setSelectedAgentId(null);
      setSelectedReasoningLevel(null);
    }
    loadedSessionRef.current = null;
    if (!projectId || !sessionId) return;
    let cancelled = false;
    apiRequest<{
      agentId: string | null;
      model: string | null;
      reasoningLevel: string | null;
    }>(
      `/api/projects/${projectId}/chat/session-overrides?sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then((data) => {
        if (cancelled) return;
        // Functional updates: never clobber a choice the user already made
        // while the fetch was in flight.
        if (data?.agentId) setSelectedAgentId((cur) => cur ?? data.agentId ?? null);
        if (data?.model) setSelectedModel((cur) => cur ?? data.model);
        if (data?.reasoningLevel) setSelectedReasoningLevel((cur) => cur ?? data.reasoningLevel);
        loadedSessionRef.current = sessionId;
      })
      .catch(() => {
        // Best-effort restore — a failed fetch just leaves the defaults, but
        // still mark the session as loaded so user changes can be persisted.
        loadedSessionRef.current = sessionId;
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);

  // Persist selector changes immediately — the pins must not depend on
  // sending a message to stick (reload/session-switch then restore them).
  // Skipped until this session's restore has settled, so the reset+fetch
  // sequence above never writes the PREVIOUS session's values into the new one.
  useEffect(() => {
    if (!sessionId) return;
    if (loadedSessionRef.current !== sessionId) return;
    apiRequest(`/api/projects/${projectId}/chat/session-overrides`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        agentId: effectiveAgentId ?? null,
        model: selectedModel,
        reasoningLevel: selectedReasoningLevel,
      }),
    }).catch(() => {
      /* Best-effort — the chat POST re-pins on the next turn anyway. */
    });
  }, [projectId, sessionId, effectiveAgentId, selectedModel, selectedReasoningLevel]);
  const handleSelectReasoningLevel = useCallback(
    (level: string) => {
      // Choosing the model's own default clears the override — the 默认强度
      // switch then flips back ON and the next turns follow the configured
      // chain again.
      setSelectedReasoningLevel(level === modelDefaultReasoningLevel ? null : level);
    },
    [modelDefaultReasoningLevel],
  );

  // Switching agent resets the model to that agent's primary (unless the user
  // had explicitly picked a model — then keep it; the backend still honors it).
  const handleSelectAgent = useCallback(
    (id: string) => {
      setSelectedAgentId(id);
      setAgentMenuOpen(false);
      const next = agents.find((a) => a.id === id);
      if (next?.model) setSelectedModel(null); // fall back to the new agent's primary
    },
    [agents],
  );

  const handleSelectModel = useCallback((ref: string) => {
    setSelectedModel(ref);
    // Deliberately keep the menu open: the reasoning-level section below the
    // model list is part of the same selection flow (the model's effective
    // default level is highlighted there), and an outside click closes both.
  }, []);

  // Model menu keyword search: filters the provider/model list while typing
  // (case-insensitive match on provider, model id, or display name).
  const [modelSearch, setModelSearch] = useState('');
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const filteredModelGroups = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return modelGroups;
    return modelGroups
      .map((g) => ({
        provider: g.provider,
        models: g.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            g.provider.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.models.length > 0);
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

  // While a selector menu is open, re-measure on viewport changes (window
  // resize, mobile address-bar collapse) so the panel stays on-screen. The
  // initial placement is already correct because the button's onClick
  // measures synchronously — this effect only re-measures later changes.
  useEffect(() => {
    if (!agentMenuOpen && !modelMenuOpen) {
      setSelectorMenuMaxH(null);
      return;
    }
    const compute = () => measureSelectorMenus(modelMenuOpen);
    compute();
    window.addEventListener('resize', compute);
    window.visualViewport?.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('resize', compute);
      window.visualViewport?.removeEventListener('resize', compute);
    };
  }, [agentMenuOpen, modelMenuOpen, measureSelectorMenus]);

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
  const [skills, setSkills] = useState<Array<{ slug: string; name: string; description: string }>>(
    [],
  );
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
    apiRequest<{ skills: Array<{ slug: string; name: string; description: string }> }>(
      '/api/skills',
    )
      .then((data) => {
        if (!cancelled) setSkills(data?.skills ?? []);
      })
      .catch(() => {
        /* skills list is optional — ignore failures */
      });
    return () => {
      cancelled = true;
    };
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

  // Streaming state is session-scoped in the chat stream store, so switching
  // sessions no longer aborts anything or resets a shared state machine —
  // the previous session's stream keeps running and its bubble is intact
  // when the user comes back (the store remembers it per session).
  const prevStreamSessionRef = useRef(sessionId);
  useEffect(() => {
    if (prevStreamSessionRef.current === sessionId) return;
    prevStreamSessionRef.current = sessionId;
    // Auto-send of a navigation-state first message belongs to one session.
    autoSentRef.current = false;
  }, [sessionId]);

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
      const data = (await response.json()) as { ok: boolean; path: string; size: number };
      return { ...item, status: 'done', path: data.path, size: data.size };
    } catch (err) {
      return {
        ...item,
        status: 'error',
        error: err instanceof Error ? err.message : 'Upload failed',
      };
    }
  }, []);

  /** Process selected files: add to upload list and upload each. */
  const handleFilesSelected = useCallback(
    async (files: FileList | File[]) => {
      const items: FileUploadItem[] = Array.from(files).map((f) => ({
        id: uid(),
        file: f,
        status: 'pending' as const,
      }));
      setFileUploads((prev) => [...prev, ...items]);
      // Upload in parallel
      const results = await Promise.all(items.map((item) => uploadFile(item)));
      setFileUploads((prev) => {
        const updated = [...prev];
        for (const result of results) {
          const idx = updated.findIndex((u) => u.id === result.id);
          if (idx >= 0) updated[idx] = result;
        }
        return updated;
      });
    },
    [uploadFile],
  );

  const removeFileUpload = useCallback((id: string) => {
    setFileUploads((prev) => {
      const item = prev.find((u) => u.id === id);
      // Delete already-uploaded file from server so orphan files don't accumulate
      if (item?.status === 'done' && item.path) {
        const token = getToken();
        fetch('/api/files', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ path: item.path }),
        }).catch(() => {
          /* best effort */
        });
      }
      return prev.filter((u) => u.id !== id);
    });
  }, []);

  const retryFileUpload = useCallback(
    async (id: string) => {
      // Read the latest item from the render-time mirror — no side effects
      // inside state updaters (StrictMode would run them twice).
      const item = fileUploadsRef.current.find((u) => u.id === id);
      if (!item || item.status === 'uploading') return;
      setFileUploads((prev) =>
        prev.map((u) =>
          u.id === id ? { ...u, status: 'uploading' as const, error: undefined } : u,
        ),
      );
      const result = await uploadFile({ ...item, status: 'uploading' });
      setFileUploads((prev) => prev.map((u) => (u.id === id ? result : u)));
    },
    [uploadFile],
  );

  /** Build file reference text and files array from uploaded files for the message.
   *  Returns markdown refs (for the agent) and a structured files array (for the UI). */
  const buildFileRefs = useCallback(
    (uploads: FileUploadItem[]): { refs: string; files: MessageFile[] } => {
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
    },
    [],
  );

  const sendMessage = useCallback(
    (messageText: string, opts?: { preserveContent?: boolean }) => {
      if (!messageText.trim() || !projectId || !sessionId) return;

      // Append uploaded file references to the message
      const doneUploads = fileUploads.filter((u) => u.status === 'done' && u.path);
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

      // The turn and its stream belong to the session-scoped store, not to
      // this component: the response keeps streaming while the user is in
      // another conversation and is still there when they come back.
      devLog('[ChatInput] starting turn via stream store', {
        sessionId,
        preview: messageText.slice(0, 40),
      });
      chatStreamStore.send(sessionId, projectId, {
        content: fullContent,
        clientMsgId: userMessage.id,
        userMessage,
        agentId: effectiveAgentId ?? undefined,
        // Null (not undefined) signals "user is back on the defaults" — the
        // server clears the session pin. A value pins it to the session.
        model: selectedModel,
        reasoningLevel: selectedReasoningLevel,
        preserveContent: opts?.preserveContent,
      });
    },
    [
      projectId,
      sessionId,
      fileUploads,
      buildFileRefs,
      effectiveAgentId,
      selectedModel,
      selectedReasoningLevel,
    ],
  );

  /** Send a steer message while the agent is already running. Does NOT abort
   *  the existing stream — the steer response streams through the same
   *  connection, so the store stays the one owner of this session's bubbles. */
  const steerMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || !projectId || !sessionId) return;

      devLog('[ChatInput] steerMessage — queueing steer', { msg: messageText.slice(0, 30) });

      // The original turn was interrupted by this steer — its 'done' event may
      // never arrive, so the store resets its turn counter and opens the
      // steer response's bubble now; the later turn_start reuses it.
      chatStreamStore.beginSteerTurn(sessionId, projectId);

      // Append uploaded file references and clear input / uploads
      const doneUploads = fileUploads.filter((u) => u.status === 'done' && u.path);
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
      // clearPrevious: false — keep the current turn's bubbles on screen.
      chatStreamStore.echo(sessionId, projectId, [userMessage], false);

      // Send steer request (non-blocking — the existing stream handles the response)
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
        // Steer is best-effort; the existing stream continues regardless
      }
    },
    [projectId, sessionId, fileUploads, buildFileRefs],
  );

  /** Send a slash command while the agent is already running.
   *  Routes through POST /chat/steer so the RUNNING stream connection is NOT
   *  aborted — previously this path opened a second SSE which killed the
   *  active stream's UI while the agent kept running server-side. The
   *  command reply (when the command completes synchronously) is echoed into
   *  the store; steered/forwarded commands respond via the existing stream. */
  const sendCommandViaSteer = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || !projectId || !sessionId) return;
      setInput('');
      // Local echo of the command itself — the steer endpoint does not persist
      // command messages, so without this the user's input would vanish from
      // the conversation view.
      chatStreamStore.echo(
        sessionId,
        projectId,
        [
          {
            id: uid(),
            session_id: sessionId,
            role: 'user',
            content: messageText,
            created_at: new Date().toISOString(),
          },
        ],
        false,
      );
      try {
        const data = await apiRequest<{ ok: boolean; reply?: string }>(
          `/api/projects/${projectId}/chat/steer`,
          { method: 'POST', body: JSON.stringify({ sessionId, message: messageText }) },
        );
        if (data?.reply) {
          chatStreamStore.echo(
            sessionId,
            projectId,
            [
              {
                id: uid(),
                session_id: sessionId,
                role: 'assistant',
                content: data.reply,
                created_at: new Date().toISOString(),
              },
            ],
            false,
          );
        }
      } catch (err) {
        console.warn('[ChatInput] command via steer failed:', err);
      }
    },
    [projectId, sessionId],
  );

  const handleSend = useCallback(() => {
    const text = textareaRef.current?.value ?? input;
    const hasFiles = fileUploads.some((u) => u.status === 'done');
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
  }, [
    input,
    sendMessage,
    sending,
    steerMessage,
    sendCommandViaSteer,
    fileUploads,
    sessionId,
    onQuickStart,
  ]);

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

  // Nothing to abort on unmount: the turn's stream lives in the session-scoped
  // store, keyed by session id. Leaving this screen (or switching sessions)
  // no longer kills a running turn's UI — that is what makes returning to a
  // conversation continue the live stream instead of starting from a blank
  // "thinking" placeholder. The store's own watchdog drops a truly dead
  // connection and re-attaches from the server baseline.

  // ── Slash command palette logic ──
  // Built-in commands and skill commands are two separate groups: the
  // dropdown renders them under their own section headers, each sorted A-Z.
  // NOTE: skills are inserted as "/skill:<slug>" — the backend skill router
  // only recognizes "/skill:<slug>" (start of message) or "$<slug>" (anywhere).
  const builtInCommands = useMemo<SlashCommand[]>(
    () => [
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
    ],
    [t],
  );

  const skillCommands = useMemo<SlashCommand[]>(
    () =>
      skills.map((s) => ({
        id: `skill:${s.slug}`,
        name: s.name,
        description: s.description || t('chat.slash.skillDefault'),
        skill: true,
      })),
    [skills, t],
  );

  // The palette is active when the whole input is exactly "/token" (typing a
  // command, no space yet) or when the user opened it via the "/" button with
  // an empty input. Once args are typed (space) it hides so Enter sends normally.
  const slashTokenMatch = /^\/([^\s/]*)$/.exec(input);
  const slashQuery = slashTokenMatch ? slashTokenMatch[1] : slashOpen && input === '' ? '' : null;
  const slashActive = slashQuery !== null;

  const matchesSlashQuery = useCallback(
    (c: SlashCommand, q: string) =>
      c.id.toLowerCase().includes(q) ||
      (c.name ?? '').toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
    [],
  );

  const filteredCommands = useMemo(() => {
    const q = (slashQuery ?? '').trim().toLowerCase();
    return builtInCommands
      .filter((c) => !q || matchesSlashQuery(c, q))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
  }, [builtInCommands, slashQuery, matchesSlashQuery]);

  const filteredSkillCommands = useMemo(() => {
    const q = (slashQuery ?? '').trim().toLowerCase();
    return skillCommands
      .filter((c) => !q || matchesSlashQuery(c, q))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));
  }, [skillCommands, slashQuery, matchesSlashQuery]);

  /** Flat list for keyboard navigation: commands first, then skills. */
  const filteredSlash = useMemo(
    () => [...filteredCommands, ...filteredSkillCommands],
    [filteredCommands, filteredSkillCommands],
  );

  const slashVisible = slashActive && !slashHidden && filteredSlash.length > 0;

  // Reset the highlight whenever the filtered list content changes.
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery, slashActive]);

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
    if (!slashVisible) {
      setSlashMaxH(null);
      return;
    }
    const compute = () => {
      const anchor = textareaRef.current?.parentElement;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12; // top margin (mt-2) + slack
      const above = rect.top - 12; // bottom margin (mb-2) + slack
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
  const applySlash = useCallback(
    (cmd: SlashCommand) => {
      const cur = textareaRef.current?.value ?? input;
      const next = cur.startsWith('/')
        ? cur.replace(/^\/[^\s/]*/, `/${cmd.id} `)
        : cur
          ? `/${cmd.id} ${cur}`
          : `/${cmd.id} `;
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
    },
    [input],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashActive && filteredSlash.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlash.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSlash.length) % filteredSlash.length);
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
  const hasDoneFiles = fileUploads.some((u) => u.status === 'done');
  const hasUploading = fileUploads.some((u) => u.status === 'uploading');

  /** One row of the slash command dropdown. `idx` is the flat keyboard-nav index. */
  const renderSlashItem = (c: SlashCommand, idx: number) => (
    <button
      key={`${c.skill ? 'skill' : 'cmd'}-${c.id}`}
      type="button"
      data-slash-idx={idx}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => applySlash(c)}
      onMouseEnter={() => setSlashIndex(idx)}
      className={`flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors ${
        idx === slashIndex ? 'bg-neutral-100 dark:bg-neutral-800' : ''
      }`}
    >
      <span
        className={`shrink-0 font-mono text-[13px] ${
          c.skill ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'
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
      // The floating notes ball lifts itself above this element, so it never sits
      // on top of the send button. Changing this attribute silently reintroduces
      // that overlap (see `notes/useBallPlacement.ts`).
      //
      // Only the *docked* composer is a bottom bar, and only a bottom bar may be
      // marked here: the hook lifts the ball by this element's height, which is
      // only "the bar" while the bar is anchored to the bottom of the column. In
      // `centered` mode this element is the full-height `flex-1` centering box
      // (the visible input floats around the middle of it), so the lift came out as
      // the height of the screen — the ball sat in the top-right corner, above the
      // viewport edge its menu opens toward, and a tap on it did nothing visible.
      // The centred case marks the visible block below instead, as `centered`.
      data-notes-avoid={centered ? undefined : ''}
      className={`chat-input-theme relative bg-white dark:bg-neutral-950 ${
        centered
          ? 'flex min-h-0 flex-1 flex-col justify-center px-3 pb-[14vh] sm:px-4'
          : /* Bottom padding = safe-area inset + 4px (6px from sm). The inset
               MUST be re-added here despite `body` carrying the same padding
               in index.css: the AppShell root is `fixed inset-0`, and a fixed
               element is positioned against the viewport — it ignores the
               body's padding entirely. The body rule only affects non-fixed
               content; `.pt-safe` / `.pb-safe` exist for exactly this reason.
               Dropping the inset here put the composer 4px from the physical
               screen edge, underneath the home indicator on notched iPhones. */
            'shrink-0 px-3 pt-0 pb-[calc(env(safe-area-inset-bottom,0px)+4px)] sm:px-4 sm:pb-[calc(env(safe-area-inset-bottom,0px)+6px)]'
      } ${isDragOver ? 'ring-2 ring-blue-400 dark:ring-blue-500' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current++;
        if (dragCounterRef.current === 1) setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
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
          {fileUploads.map((item) => (
            <div
              key={item.id}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                item.status === 'error'
                  ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                  : 'border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
              }`}
            >
              {item.status === 'uploading' && (
                <Loader2 size={12} className="animate-spin shrink-0" />
              )}
              {item.status === 'pending' && (
                <svg
                  className="h-3 w-3 shrink-0 animate-pulse text-neutral-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 2v20M2 12h20" />
                </svg>
              )}
              <span className="truncate max-w-[120px]">{item.file.name}</span>
              {item.status === 'done' && (
                <span className="text-neutral-400 shrink-0">
                  ({formatFileSize(item.file.size)})
                </span>
              )}
              {item.status === 'error' && (
                <>
                  <span className="text-red-500 truncate max-w-[100px]">
                    {item.error || t('chat.input.uploadFailed')}
                  </span>
                  <button
                    onClick={() => retryFileUpload(item.id)}
                    className="underline hover:no-underline shrink-0"
                  >
                    {t('chat.input.retry')}
                  </button>
                </>
              )}
              <button
                onClick={() => removeFileUpload(item.id)}
                className="hover:opacity-70 transition-opacity shrink-0"
                aria-label={t('chat.input.remove')}
              >
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
            <h2 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-200">
              {t('chat.startNew')}
            </h2>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            setAttachActive(false);
            if (e.target.files && e.target.files.length > 0) handleFilesSelected(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Anchor wrapper — the palette and the corner buttons are positioned
            relative to the textarea itself, not the outer column, so the
            palette's bottom edge always hugs the input.

            The textarea reserves a bottom band (pb-[40px]) instead of side
            paddings: the corner controls (slash button + agent/model pills on
            the left, attach + send on the right) sit *inside* that band, so
            text uses the full width of the box. Reserving width on the right
            instead (the previous `pr-[88px]`) pushed every line's wrap point
            88px short of the right edge, which is visible with long text — and
            on the left it never reserved anything at all, so the last line
            already ran under the pills. The band is sized to the taller of the
            two control rows (h-7 = 28px at `bottom-1.5` → 34px) plus slack. */}
        {/* The input box itself — what the ball stands beside while this column is
            centred rather than docked. The welcome header above it is deliberately
            *not* part of the mark: measuring from the top of the header put the ball
            100-odd pixels above the box it belongs to. Not flush with the bottom of
            the column, hence `centered` rather than a bottom bar. */}
        <div data-notes-avoid={centered ? 'centered' : undefined} className="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSlashHidden(false);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setSlashHidden(false)}
            onBlur={() => {
              setSlashOpen(false);
              setSlashHidden(true);
            }}
            placeholder={
              isCompactViewport ? t('chat.input.placeholderMobile') : t('chat.input.placeholder')
            }
            rows={4}
            disabled={!projectId || (!sessionId && !onQuickStart)}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-neutral-300 bg-white px-3 pt-2.5 pb-[40px] text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none disabled:opacity-50 sm:px-4 sm:pt-3 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-600"
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
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setSlashOpen((o) => !o);
              setSlashHidden(false);
            }}
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
            agent's primary model). Selections travel in the POST body.

            The row is capped to leave room for the right-side corner buttons
            (attach + send, ~6rem from the right edge). When the model ref is
            too long to fit, the flex row shrinks the model button (the agent
            button never shrinks) and the ref text truncates instead of
            overlapping the attachment button — auto-width is preserved for
            short names. Mobile uses tighter left offset/gap to keep the
            three pills visually adjacent. */}
          <div
            ref={selectorRef}
            className="absolute bottom-1.5 left-[30px] flex max-w-[calc(100%-6rem)] items-center gap-0 sm:left-9 sm:gap-1"
          >
            {/* Agent selector */}
            <div className="relative shrink-0">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (agentMenuOpen) {
                    setAgentMenuOpen(false);
                    return;
                  }
                  // Measure synchronously BEFORE opening so the first frame
                  // already has the capped height (panel opens upward, capped
                  // to the space above the input).
                  measureSelectorMenus(false);
                  setAgentMenuOpen(true);
                  setModelMenuOpen(false);
                }}
                disabled={!projectId || (!sessionId && !onQuickStart) || agents.length === 0}
                aria-label={t('chat.input.agentSelector')}
                title={t('chat.input.agentSelector')}
                className="inline-flex h-6 max-w-[130px] items-center gap-0.5 rounded-full border border-transparent px-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 sm:gap-1 sm:max-w-[160px] sm:px-2"
              >
                <Bot size={12} className="shrink-0" />
                <span className="truncate">
                  {effectiveAgent?.name ?? t('chat.input.agentDefault')}
                </span>
                <ChevronDown size={11} className="shrink-0 opacity-60" />
              </button>
              {agentMenuOpen && (
                <div
                  style={selectorMenuMaxH != null ? { maxHeight: selectorMenuMaxH } : undefined}
                  className="absolute bottom-full left-0 z-30 mb-2 w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <div className="flex items-center justify-between gap-2 pb-1 pe-2 ps-3 pt-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {t('chat.input.agentMenuHeader')}
                    </span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setAgentMenuOpen(false);
                        openSettings('agents');
                      }}
                      aria-label={t('chat.input.manageAgents')}
                      title={t('chat.input.manageAgents')}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                    >
                      <Settings size={13} />
                    </button>
                  </div>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleSelectAgent(a.id)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                        a.id === effectiveAgentId
                          ? 'bg-neutral-100 dark:bg-neutral-800'
                          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-200">
                        {a.name}
                      </span>
                      {a.id === effectiveAgentId && (
                        <Check size={12} className="shrink-0 text-blue-500" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Model selector — min-w-0 lets the flex row shrink this pill
              (never the agent pill) when the combined width would reach the
              right-side corner buttons; the ref text truncates. */}
            <div className="relative min-w-0">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (modelMenuOpen) {
                    setModelMenuOpen(false);
                    return;
                  }
                  // Measure synchronously BEFORE opening so the first frame
                  // already has the capped height; the panel opens upward in
                  // every mode (incl. centered new-session) and stays inside
                  // the space above the input, so the search box is visible.
                  measureSelectorMenus(true);
                  setModelMenuOpen(true);
                  setAgentMenuOpen(false);
                }}
                disabled={!projectId || (!sessionId && !onQuickStart) || modelGroups.length === 0}
                aria-label={t('chat.input.modelSelector')}
                title={t('chat.input.modelSelector')}
                className="inline-flex h-6 min-w-0 max-w-full items-center gap-0.5 rounded-full border border-transparent px-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200 sm:gap-1 sm:px-2"
              >
                <Brain size={12} className="shrink-0" />
                <span className="min-w-0 truncate">
                  {effectiveModel ?? t('chat.input.modelDefault')}
                </span>
                {/* Reasoning-level override badge — only shown when the user
                  deviates from the model's effective default (which would just
                  duplicate the model name otherwise). */}
                {selectedReasoningLevel && reasoningAvailable && (
                  <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-px text-[10px] font-semibold text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
                    {selectedReasoningLevel}
                  </span>
                )}
                <ChevronDown size={11} className="shrink-0 opacity-60" />
              </button>
              {modelMenuOpen && (
                <div
                  style={selectorMenuMaxH != null ? { maxHeight: selectorMenuMaxH } : undefined}
                  className="absolute bottom-full left-0 z-30 mb-2 flex max-h-[min(24rem,70vh)] w-64 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {/* Keyword search — filters the model list as you type.
                    The + button on the right opens settings on the providers
                    sub-tab for adding providers/models. */}
                  <div className="sticky top-0 z-10 flex shrink-0 items-center gap-1 bg-white pe-1.5 ps-2 pb-1.5 pt-1.5 dark:bg-neutral-900">
                    <input
                      ref={modelSearchRef}
                      type="text"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && firstFilteredModelRef) {
                          e.preventDefault();
                          handleSelectModel(firstFilteredModelRef);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setModelMenuOpen(false);
                        }
                      }}
                      placeholder={t('chat.input.modelSearch')}
                      className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-neutral-600"
                    />
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setModelMenuOpen(false);
                        openSettings('models', 'providers');
                      }}
                      aria-label={t('chat.input.manageProviders')}
                      title={t('chat.input.manageProviders')}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                    >
                      <Settings size={14} />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {filteredModelGroups.length === 0 && (
                      <div className="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-500">
                        {t('chat.input.modelSearchNoMatch')}
                      </div>
                    )}
                    {filteredModelGroups.map((g) => (
                      <div key={g.provider}>
                        <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                          {g.provider}
                        </div>
                        {g.models.map((m) => {
                          const ref = `${g.provider}/${m.id}`;
                          return (
                            <button
                              key={ref}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSelectModel(ref)}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                ref === effectiveModel
                                  ? 'bg-neutral-100 dark:bg-neutral-800'
                                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                              }`}
                            >
                              <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-200">
                                {m.name}
                              </span>
                              {ref === effectiveModel && (
                                <Check size={12} className="shrink-0 text-blue-500" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {/* Deep thinking — inline at the bottom of the same menu
                    instead of a separate selector/bottom-bar button (the mobile
                    input bar has no room for one). The 深度思考 switch off =
                    'off' level; on = pick one of the 6 level chips (3 per row).
                    The 默认强度 switch is ON while the selection equals the
                    model's effective default (per-model config > Model Router
                    tab's defaultReasoningLevel > 'off') and restores it in one
                    click. Hidden for models the catalog marks non-reasoning. */}
                  {reasoningAvailable && (
                    <div className="shrink-0 border-t border-neutral-200 dark:border-neutral-700">
                      <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                            {t('chat.input.reasoningLevel')}
                          </span>
                          <Toggle
                            checked={depthEnabled}
                            onChange={handleToggleDepth}
                            ariaLabel={t('chat.input.reasoningLevel')}
                            // Same colors as a selected level chip, with the
                            // tinted background one step deeper for contrast.
                            checkedClassName="border-blue-500 bg-blue-100 dark:border-blue-400 dark:bg-blue-500/25"
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                            {t('chat.input.reasoningLevelDefault')}
                          </span>
                          <Toggle
                            checked={followingDefault}
                            onChange={handleToggleDefault}
                            ariaLabel={t('chat.input.reasoningLevelDefault')}
                            checkedClassName="border-blue-500 bg-blue-100 dark:border-blue-400 dark:bg-blue-500/25"
                          />
                        </div>
                      </div>
                      {depthEnabled && (
                        <div className="grid grid-cols-3 gap-1 px-2.5 pb-1.5">
                          {REASONING_LEVELS.filter((level) => level !== 'off').map((level) => (
                            <button
                              key={level}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleSelectReasoningLevel(level)}
                              className={`flex items-center justify-center gap-1 rounded-md border px-1 py-1 text-[11px] transition-colors ${
                                level === effectiveReasoningLevel
                                  ? 'border-blue-500 bg-blue-50 font-semibold text-blue-700 dark:border-blue-400 dark:bg-blue-500/15 dark:text-blue-300'
                                  : 'border-neutral-200 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800'
                              }`}
                            >
                              <span className="min-w-0 truncate">{level}</span>
                              {level === effectiveReasoningLevel && (
                                <Check size={11} className="shrink-0" />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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
              onClick={() => {
                if (attachActive) return;
                setAttachActive(true);
                fileInputRef.current?.click();
              }}
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
              same active-blue background); clicking stops the agent. But if
              the user has typed new content (or attached files) while the
              agent is running, show the send button instead — sending then
              routes through steer, not abort. */}
            {sending && sessionId && !hasInput && !hasDoneFiles ? (
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
                  } else if (sessionId && !sending) {
                    sendMessage('/stop');
                  }
                }}
                disabled={
                  (!hasInput && !hasDoneFiles) ||
                  !projectId ||
                  hasUploading ||
                  (!sessionId && !onQuickStart)
                }
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
