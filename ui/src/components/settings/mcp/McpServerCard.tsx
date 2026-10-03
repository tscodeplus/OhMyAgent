// ---------------------------------------------------------------------------
// MCP settings — server card, tool table and the MCP WebUI view models
// ---------------------------------------------------------------------------
//
// See MyDocs/MCP_INTEGRATION_DESIGN.md §13.1 (state model), §13.2 (card layout,
// tool rows) and §13.7 (API contract).
//
// The API view models are declared here instead of imported from
// `src/mcp/types.ts`: that file is the *server* contract and the WebUI is a
// separate TypeScript project (`ui/tsconfig.json`) that never type-checks
// against it. Field names are copied verbatim — never rename one side only.
//
// `McpToolTable` also lives in this file because §13.2 (card, inline tool list)
// and §13.6 (detail drawer) render the same row: name, description, annotation
// badges and the effective-exposure dropdown. This file is the base of the MCP
// import graph, so sharing it here adds no back-edge into the drawer.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  LogIn,
  LogOut,
  MoreVertical,
  Pencil,
  RotateCw,
  Trash2,
} from 'lucide-react';
import Toggle from '../../ui/Toggle';
import Select from '../../ui/Select';
import Spinner from '../../ui/Spinner';

// ─── View models (mirrors of src/mcp/types.ts, §13.7) ───

export type McpTransport = 'stdio' | 'http';

/** How a server's tools are surfaced to the model. */
export type McpExposure = 'direct' | 'deferred' | 'hidden';

export type McpConnectionState =
  'disabled' | 'connecting' | 'connected' | 'disconnected' | 'auth_required' | 'error';

export interface McpOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
  callbackUrl: string;
  scope: string;
  clientName: string;
  authServerMetadataUrl: string;
}

/** `GET /api/mcp/servers` — one installed server. */
export interface McpServerView {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  exposure: McpExposure;
  description: string;
  state: McpConnectionState;
  error?: string;
  errorCount: number;
  connectedAt?: number;
  toolCount: number;
  /** True when OAuth credentials are stored (never the token itself). */
  oauth: boolean;
  authRequired: boolean;
  /** stdio only. */
  command?: string;
  args?: string[];
  cwd?: string;
  envKeys?: string[];
  /** http only. */
  url?: string;
  headerKeys?: string[];
  toolExposure: Record<string, McpExposure>;
  timeoutSec?: number;
}

/** `GET /api/mcp/servers/:name/tools` — manager cache, includes `hidden` tools. */
export interface McpToolView {
  /** Registered tool name, `mcp__<server>__<tool>`. */
  name: string;
  /** Raw tool name as declared by the server. */
  rawName: string;
  title?: string;
  description?: string;
  /** Effective exposure after the `tool_exposure` overrides. */
  exposure: McpExposure;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

/** `POST` / `PUT /api/mcp/servers` body. */
export interface McpServerInput {
  name: string;
  enabled?: boolean;
  exposure?: McpExposure;
  description?: string;
  toolExposure?: Record<string, McpExposure>;
  timeoutSec?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: Partial<McpOAuthConfig>;
}

/** `GET /api/mcp/status`. */
export interface McpStatusView {
  installed: number;
  enabled: number;
  connected: number;
  authRequired: number;
  errorCount: number;
}

/** One environment variable a preset may need (§13.3a). */
export interface McpPresetEnvVar {
  key: string;
  /** One-line hint rendered next to the input. */
  hint: string;
  /** The server refuses to start without it. */
  required: boolean;
  /** Mask the value in the form and never echo it back through the API. */
  secret?: boolean;
}

/**
 * `GET /api/mcp/presets` — §13.3(a).
 *
 * Mirrors `McpPreset` in src/mcp/presets.ts, which is the single source of
 * truth. The UI project cannot import from src/, so this is a deliberate
 * structural copy — keep the two in sync.
 */
export interface McpPreset {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Suggested exposure for every tool of this server. */
  exposure: McpExposure;
  /** Env vars to offer; empty when the server needs none. */
  env: McpPresetEnvVar[];
  docsUrl: string;
}

/** `POST /api/mcp/test` — dry connect, nothing is persisted (§13.3). */
export interface McpTestResult {
  ok: boolean;
  serverInfo?: { name?: string; version?: string; protocolVersion?: string };
  /** Tool preview; the server may return full MCP `Tool` objects. */
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
  /** Tail of the child process stderr (stdio only). */
  stderrTail?: string;
}

/** Sections of the detail drawer (§13.6), used for deep links from the menu. */
export type McpDetailSection = 'connection' | 'tools' | 'auth' | 'logs' | 'rawConfig';

/** i18n key of the human-readable label for a connection state. */
export function mcpStateKey(state: McpConnectionState): string {
  switch (state) {
    case 'auth_required':
      return 'settings.mcp.state.authRequired';
    case 'connected':
    case 'connecting':
    case 'disconnected':
    case 'error':
    case 'disabled':
      return `settings.mcp.state.${state}`;
  }
}

const STATUS_DOT: Record<McpConnectionState, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-neutral-400 dark:bg-neutral-500',
  auth_required: 'bg-amber-500',
  error: 'bg-red-500',
  disabled: 'bg-neutral-300 dark:bg-neutral-600',
};

/** Tailwind classes of the status dot — the colour is never the only signal. */
export function mcpStatusDotClass(state: McpConnectionState): string {
  return STATUS_DOT[state];
}

/**
 * Effective card state. `enabled: false` wins over the connection state — a
 * disabled server is not connected at all (§13.1), and a stale
 * `authRequired` flag must not keep painting a key icon on a stopped server.
 */
export function mcpCardState(server: McpServerView): McpConnectionState {
  if (!server.enabled || server.state === 'disabled') return 'disabled';
  if (server.authRequired) return 'auth_required';
  return server.state;
}

// ─── Tool table (shared by the card expansion and the detail drawer) ───

export interface McpToolTableProps {
  /** `undefined` while the tool list is still being fetched. */
  tools?: McpToolView[];
  /** Name of the tool whose exposure patch is in flight. */
  pendingTool?: string | null;
  onSetExposure?: (tool: McpToolView, exposure: McpExposure) => void;
}

export function McpToolTable({ tools, pendingTool = null, onSetExposure }: McpToolTableProps) {
  const { t } = useTranslation('common');

  if (!tools) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size="sm" />
      </div>
    );
  }
  if (tools.length === 0) {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('settings.mcp.toolsEmpty')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            <th className="py-1.5 pr-3 font-medium">{t('settings.mcp.form.name')}</th>
            <th className="py-1.5 pr-3 font-medium">{t('settings.mcp.form.description')}</th>
            <th className="py-1.5 pr-3 font-medium">{t('settings.mcp.annotations.title')}</th>
            <th className="py-1.5 font-medium">{t('settings.mcp.form.exposure')}</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr
              key={tool.name}
              className="border-t border-neutral-100 dark:border-neutral-800 align-top"
            >
              <td className="py-2 pr-3">
                <span
                  className="block max-w-[220px] truncate font-mono text-xs text-neutral-800 dark:text-neutral-200"
                  title={`${tool.name} · ${tool.rawName}`}
                >
                  {tool.name}
                </span>
                <span className="block truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                  {tool.title || tool.rawName}
                </span>
              </td>
              <td className="py-2 pr-3">
                <span
                  className="block max-w-[260px] truncate text-xs text-neutral-500 dark:text-neutral-400"
                  title={tool.description || ''}
                >
                  {tool.description || '—'}
                </span>
              </td>
              <td className="py-2 pr-3">
                <div className="flex flex-wrap gap-1">
                  {tool.readOnly && (
                    <AnnotationBadge label={t('settings.mcp.annotations.readOnly')} />
                  )}
                  {tool.destructive && (
                    <AnnotationBadge
                      label={t('settings.mcp.annotations.destructive')}
                      tone="danger"
                    />
                  )}
                  {tool.idempotent && (
                    <AnnotationBadge label={t('settings.mcp.annotations.idempotent')} />
                  )}
                  {tool.openWorld && (
                    <AnnotationBadge label={t('settings.mcp.annotations.openWorld')} />
                  )}
                </div>
              </td>
              <td className="py-2">
                <Select
                  compact
                  options={EXPOSURE_OPTIONS}
                  value={tool.exposure}
                  disabled={!onSetExposure || pendingTool === tool.name}
                  onChange={(e) => onSetExposure?.(tool, e.target.value as McpExposure)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Config tokens double as labels: they are the vocabulary used in config.yaml. */
const EXPOSURE_OPTIONS = [
  { value: 'direct', label: 'direct' },
  { value: 'deferred', label: 'deferred' },
  { value: 'hidden', label: 'hidden' },
];

function AnnotationBadge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'danger';
}) {
  const cls =
    tone === 'danger'
      ? 'border-red-200 text-red-600 dark:border-red-900 dark:text-red-400'
      : 'border-neutral-200 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400';
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap ${cls}`}
    >
      {label}
    </span>
  );
}

// ─── Card ───

interface MenuItem {
  key: string;
  label: string;
  icon: typeof Pencil;
  onClick: () => void;
  danger?: boolean;
}

export interface McpServerCardProps {
  server: McpServerView;
  /** Cached tools for this server; `undefined` until the tab's fetch lands. */
  tools?: McpToolView[];
  /** A server-level action (toggle / reconnect / uninstall) is in flight. */
  busy?: boolean;
  pendingTool?: string | null;
  onToggle: (server: McpServerView, enabled: boolean) => void;
  onEdit: (server: McpServerView) => void;
  onOpenDetail: (server: McpServerView, section: McpDetailSection) => void;
  onReconnect: (server: McpServerView) => void;
  onLogin: (server: McpServerView) => void;
  onLogout: (server: McpServerView) => void;
  onUninstall: (server: McpServerView) => void;
  onSetToolExposure: (server: McpServerView, tool: McpToolView, exposure: McpExposure) => void;
}

export default function McpServerCard({
  server,
  tools,
  busy = false,
  pendingTool = null,
  onToggle,
  onEdit,
  onOpenDetail,
  onReconnect,
  onLogin,
  onLogout,
  onUninstall,
  onSetToolExposure,
}: McpServerCardProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const state = mcpCardState(server);
  const enabled = server.enabled && server.state !== 'disabled';

  const menuItems: MenuItem[] = [];
  menuItems.push({
    key: 'details',
    label: t('settings.mcp.action.details'),
    icon: Info,
    onClick: () => onOpenDetail(server, 'connection'),
  });
  menuItems.push({
    key: 'edit',
    label: t('settings.mcp.action.edit'),
    icon: Pencil,
    onClick: () => onEdit(server),
  });
  // A stopped server has no client to reconnect, log in or log out (§13.5).
  if (enabled) {
    menuItems.push({
      key: 'reconnect',
      label: t('settings.mcp.action.reconnect'),
      icon: RotateCw,
      onClick: () => onReconnect(server),
    });
    if (server.transport === 'http') {
      menuItems.push({
        key: 'login',
        label: t('settings.mcp.action.login'),
        icon: LogIn,
        onClick: () => onLogin(server),
      });
      if (server.oauth) {
        menuItems.push({
          key: 'logout',
          label: t('settings.mcp.action.logout'),
          icon: LogOut,
          onClick: () => onLogout(server),
        });
      }
    }
  }
  menuItems.push({
    key: 'logs',
    label: t('settings.mcp.action.logs'),
    icon: FileText,
    onClick: () => onOpenDetail(server, 'logs'),
  });
  menuItems.push({
    key: 'uninstall',
    label: t('settings.mcp.action.uninstall'),
    icon: Trash2,
    onClick: () => onUninstall(server),
    danger: true,
  });

  return (
    // No `overflow-hidden`: the `⋯` menu and the tool table's exposure dropdown
    // are absolutely positioned and would be clipped while the card is collapsed.
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-neutral-400" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-neutral-400" />
          )}
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${mcpStatusDotClass(state)}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {server.name}
              </span>
              <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] uppercase leading-none text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                {t(`settings.mcp.transport.${server.transport}`)}
              </span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {server.toolCount > 0
                  ? t('settings.mcp.toolCount', { count: server.toolCount })
                  : '—'}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="text-neutral-600 dark:text-neutral-400">
                {t(mcpStateKey(state))}
              </span>
              {server.description ? (
                <span className="truncate text-neutral-400 dark:text-neutral-500">
                  {server.description}
                </span>
              ) : null}
            </span>
          </span>
        </button>

        {enabled && state === 'auth_required' && server.transport === 'http' && (
          <button
            type="button"
            onClick={() => onLogin(server)}
            className="shrink-0 rounded-md border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/30"
          >
            {t('settings.mcp.action.login')}
          </button>
        )}

        {busy && <Spinner size="sm" />}

        <Toggle
          checked={server.enabled}
          disabled={busy}
          ariaLabel={enabled ? t('settings.mcp.disable') : t('settings.mcp.enable')}
          onChange={(next) => onToggle(server, next)}
        />

        <CardMenu items={menuItems} disabled={busy} />
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-neutral-200 px-3 py-3 sm:px-4 dark:border-neutral-800">
          {state === 'error' && server.error ? (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/30">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-500" />
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-red-700 dark:text-red-300">
                {server.error}
              </pre>
            </div>
          ) : null}
          <McpToolTable
            tools={tools}
            pendingTool={pendingTool}
            onSetExposure={(tool, exposure) => onSetToolExposure(server, tool, exposure)}
          />
        </div>
      )}
    </div>
  );
}

/** `⋯` overflow menu; closes on outside click and Escape. */
function CardMenu({ items, disabled }: { items: MenuItem[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        <MoreVertical size={16} strokeWidth={1.75} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-[60] mt-1 w-40 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700/60 ${
                item.danger
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-neutral-700 dark:text-neutral-300'
              }`}
            >
              <item.icon size={13} strokeWidth={1.75} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
