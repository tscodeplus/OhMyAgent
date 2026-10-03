// ---------------------------------------------------------------------------
// MCP settings — server detail drawer (§13.6)
// ---------------------------------------------------------------------------
//
// Right-hand drawer opened from a card's `⋯` menu. Sections: connection, tools,
// auth, logs and the (masked) raw config. Auth scope/expiry are not exposed by
// `McpServerView`, so the auth block shows the stored-credentials flag and the
// login/logout actions instead of inventing fields.
//
// Logs are tailed from `GET /api/mcp/servers/:name/logs?lines=200` with an
// opt-in auto-refresh — the route reads the tail of the file, it never loads
// the whole log into the response.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn, LogOut, RotateCw, X } from 'lucide-react';
import Button from '../../ui/Button';
import Toggle from '../../ui/Toggle';
import { apiRequest } from '../../../utils/api';
import { McpToolTable, mcpCardState, mcpStateKey, mcpStatusDotClass } from './McpServerCard';
import { readRawServerConfig } from './McpServerForm';
import type { McpDetailSection, McpExposure, McpServerView, McpToolView } from './McpServerCard';

const LOG_TAIL_LINES = 200;
const LOG_POLL_MS = 5000;

export interface McpServerDetailProps {
  server: McpServerView;
  tools?: McpToolView[];
  pendingTool?: string | null;
  /** Section to scroll to when the drawer opens. */
  initialSection?: McpDetailSection;
  onClose: () => void;
  onLogin: (server: McpServerView) => void;
  onLogout: (server: McpServerView) => void;
  onReconnect: (server: McpServerView) => void;
  onSetToolExposure: (server: McpServerView, tool: McpToolView, exposure: McpExposure) => void;
}

export default function McpServerDetail({
  server,
  tools,
  pendingTool = null,
  initialSection,
  onClose,
  onLogin,
  onLogout,
  onReconnect,
  onSetToolExposure,
}: McpServerDetailProps) {
  const { t } = useTranslation('common');
  const state = mcpCardState(server);
  const [lines, setLines] = useState<string[] | null>(null);
  const [logsFailed, setLogsFailed] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [rawConfig, setRawConfig] = useState<Record<string, unknown> | null | undefined>(undefined);

  const sections = useRef<Record<string, HTMLDivElement | null>>({});

  const loadLogs = useCallback(() => {
    apiRequest<{ lines: string[] }>(
      `/api/mcp/servers/${encodeURIComponent(server.name)}/logs?lines=${LOG_TAIL_LINES}`,
    )
      .then((data) => {
        setLines(data.lines ?? []);
        setLogsFailed(false);
      })
      .catch(() => {
        // No log file yet / route unavailable — the section renders as empty.
        setLines([]);
        setLogsFailed(true);
      });
  }, [server.name]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(loadLogs, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, loadLogs]);

  useEffect(() => {
    apiRequest<Record<string, unknown>>('/api/config')
      .then((config) => setRawConfig(readRawServerConfig(config, server.name) ?? null))
      .catch(() => setRawConfig(null));
  }, [server.name]);

  useEffect(() => {
    if (!initialSection) return;
    // The drawer is mounted on open, so section refs are attached by now.
    sections.current[initialSection]?.scrollIntoView({ block: 'start' });
  }, [initialSection]);

  const registerSection = (key: string) => (node: HTMLDivElement | null) => {
    sections.current[key] = node;
  };

  return (
    // z-index stays below the dialog layer (`ui/Modal` is z-[100]) so that the
    // login / uninstall dialogs opened from inside the drawer are painted on top;
    // it only has to beat the settings modal's own content.
    <div className="fixed inset-y-0 right-0 z-[90] flex w-full max-w-full flex-col border-l border-neutral-200 bg-white shadow-2xl sm:w-[560px] sm:max-w-[90vw] dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${mcpStatusDotClass(state)}`}
              aria-hidden="true"
            />
            <h3 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {server.name}
            </h3>
            <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] uppercase leading-none text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
              {t(`settings.mcp.transport.${server.transport}`)}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('settings.mcp.detail.title')} · {t(mcpStateKey(state))}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {server.enabled && server.state !== 'disabled' && (
            <button
              type="button"
              onClick={() => onReconnect(server)}
              aria-label={t('settings.mcp.action.reconnect')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <RotateCw size={14} strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {/* ── Connection ── */}
        <section ref={registerSection('connection')} className="space-y-2">
          <SectionTitle title={t('settings.mcp.detail.connection')} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <Row label={t('settings.mcp.detail.state')} value={t(mcpStateKey(state))} />
            <Row
              label={t('settings.mcp.detail.endpoint')}
              value={
                server.transport === 'stdio'
                  ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || '—'
                  : server.url || '—'
              }
              mono
            />
            {server.transport === 'stdio' ? (
              <>
                <Row label={t('settings.mcp.form.cwd')} value={server.cwd || '—'} mono />
                <Row
                  label={t('settings.mcp.form.env')}
                  value={(server.envKeys ?? []).join(', ') || '—'}
                  mono
                />
              </>
            ) : (
              <Row
                label={t('settings.mcp.form.headers')}
                value={(server.headerKeys ?? []).join(', ') || '—'}
                mono
              />
            )}
            <Row
              label={t('settings.mcp.detail.connectedAt')}
              value={server.connectedAt ? new Date(server.connectedAt).toLocaleString() : '—'}
            />
            <Row label={t('settings.mcp.detail.errorCount')} value={String(server.errorCount)} />
            {server.timeoutSec ? (
              <Row label={t('settings.mcp.form.timeout')} value={String(server.timeoutSec)} />
            ) : null}
          </dl>
          {server.error ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-red-600 dark:text-red-400">
                {t('settings.mcp.state.error')}
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                {server.error}
              </pre>
            </div>
          ) : null}
        </section>

        {/* ── Tools ── */}
        <section ref={registerSection('tools')} className="space-y-2">
          <SectionTitle title={`${t('settings.mcp.detail.tools')} (${server.toolCount})`} />
          <McpToolTable
            tools={tools}
            pendingTool={pendingTool}
            onSetExposure={(tool, exposure) => onSetToolExposure(server, tool, exposure)}
          />
        </section>

        {/* ── Auth ── */}
        {server.transport === 'http' && (
          <section ref={registerSection('auth')} className="space-y-2">
            <SectionTitle title={t('settings.mcp.detail.auth')} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <Row
                label={t('settings.mcp.detail.credentials')}
                value={server.oauth ? t('settings.mcp.detail.yes') : t('settings.mcp.detail.no')}
              />
              <Row label={t('settings.mcp.detail.state')} value={t(mcpStateKey(state))} />
            </dl>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => onLogin(server)}>
                <LogIn size={13} />
                {t('settings.mcp.action.login')}
              </Button>
              {server.oauth && (
                <Button size="sm" variant="secondary" onClick={() => onLogout(server)}>
                  <LogOut size={13} />
                  {t('settings.mcp.action.logout')}
                </Button>
              )}
            </div>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('settings.mcp.oauth.headlessHint')}
            </p>
          </section>
        )}

        {/* ── Logs ── */}
        <section ref={registerSection('logs')} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle title={t('settings.mcp.detail.logs')} />
            <div className="flex items-center gap-2 pb-1">
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('settings.mcp.logs.autoRefresh')}
              </span>
              <Toggle
                checked={autoRefresh}
                onChange={setAutoRefresh}
                ariaLabel={t('settings.mcp.logs.autoRefresh')}
              />
            </div>
          </div>
          {lines === null ? (
            <p className="text-xs text-neutral-400">{t('common.loading')}</p>
          ) : lines.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {logsFailed ? t('common.error') : t('settings.mcp.logs.empty')}
            </p>
          ) : (
            <pre className="max-h-64 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
              {lines.join('\n')}
            </pre>
          )}
        </section>

        {/* ── Raw config ── */}
        <section ref={registerSection('rawConfig')} className="space-y-2">
          <SectionTitle title={t('settings.mcp.detail.rawConfig')} />
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('settings.mcp.detail.rawConfigHint')}
          </p>
          {rawConfig === undefined ? (
            <p className="text-xs text-neutral-400">{t('common.loading')}</p>
          ) : rawConfig === null ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('common.noData')}</p>
          ) : (
            <pre className="max-h-64 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
              {JSON.stringify(rawConfig, null, 2)}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
      {title}
    </h4>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd
        className={`min-w-0 break-all text-neutral-800 dark:text-neutral-200 ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </dd>
    </>
  );
}
