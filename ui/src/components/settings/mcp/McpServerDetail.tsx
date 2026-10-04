// ---------------------------------------------------------------------------
// MCP settings — server detail drawer (§13.6)
// ---------------------------------------------------------------------------
//
// Right-hand drawer opened from a card's `⋯` menu. Sections: connection, tools,
// resources, auth, logs and the raw `config.yaml` fragment. Auth scope/expiry
// are not exposed by `McpServerView`, so the auth block shows the stored-
// credentials flag and the login/logout actions instead of inventing fields.
//
// Logs are tailed from `GET /api/mcp/servers/:name/logs?lines=200` with an
// opt-in auto-refresh — the route reads the tail of the file, it never loads
// the whole log into the response.
//
// Two panes read dedicated routes rather than `GET /api/config`:
//   - resources: `GET /api/mcp/servers/:name/resources` (read-only list of the
//     server's resources and templates).
//   - raw config: `GET /api/mcp/servers/:name/raw`, which returns the masked
//     `config.yaml` fragment with `${ENV}` placeholders *unexpanded* (§13.6).
//     `/api/config` is deliberately NOT used: it is normalised, camelCase and
//     already expanded, which is exactly what the raw pane must not show.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn, LogOut, RotateCw, X } from 'lucide-react';
import Button from '../../ui/Button';
import Toggle from '../../ui/Toggle';
import { apiRequest } from '../../../utils/api';
import { McpToolTable, mcpCardState, mcpStateKey, mcpStatusDotClass } from './McpServerCard';
import type {
  McpDetailSection,
  McpExposure,
  McpResourceView,
  McpResourcesResponse,
  McpServerView,
  McpToolView,
} from './McpServerCard';

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
  onSetToolEnabled: (server: McpServerView, tool: McpToolView, enabled: boolean) => void;
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
  onSetToolEnabled,
}: McpServerDetailProps) {
  const { t } = useTranslation('common');
  const state = mcpCardState(server);
  const [lines, setLines] = useState<string[] | null>(null);
  const [logsFailed, setLogsFailed] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // `undefined` = loading, `null` = \"no raw fragment available\", string = the fragment.
  const [rawYaml, setRawYaml] = useState<string | null | undefined>(undefined);
  const [resources, setResources] = useState<McpResourcesResponse | null>(null);
  const [resourcesFailed, setResourcesFailed] = useState(false);

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

  const loadResources = useCallback(() => {
    // Reset before the fetch so a retry (or a server switch) shows the loading
    // state instead of the previous server's list.
    setResources(null);
    setResourcesFailed(false);
    apiRequest<McpResourcesResponse>(
      `/api/mcp/servers/${encodeURIComponent(server.name)}/resources`,
    )
      .then((data) => setResources(data))
      .catch(() => {
        setResources(null);
        setResourcesFailed(true);
      });
  }, [server.name]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  useEffect(() => {
    let cancelled = false;
    setRawYaml(undefined);
    apiRequest<{ yaml: string | null; reason?: string }>(
      `/api/mcp/servers/${encodeURIComponent(server.name)}/raw`,
    )
      .then((data) => {
        if (!cancelled) setRawYaml(data.yaml ?? null);
      })
      .catch(() => {
        // Route unavailable / server vanished: say \"unavailable\", never fall
        // back to the expanded `/api/config` view this pane must not show.
        if (!cancelled) setRawYaml(null);
      });
    return () => {
      cancelled = true;
    };
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
            <Row
              label={t('settings.mcp.detail.protocolVersion')}
              value={server.serverInfo?.protocolVersion || '—'}
              mono
            />
            <Row
              label={t('settings.mcp.detail.serverName')}
              value={server.serverInfo?.name || '—'}
              mono
            />
            <Row
              label={t('settings.mcp.detail.serverVersion')}
              value={server.serverInfo?.version || '—'}
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
          {server.instructionsSummary ? (
            <details className="rounded-md border border-neutral-200 dark:border-neutral-800">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                {t('settings.mcp.detail.instructions')}
              </summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-neutral-200 px-3 py-2 font-mono text-[11px] text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
                {server.instructionsSummary}
              </pre>
            </details>
          ) : null}
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
          {server.lastError ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-red-600 dark:text-red-400">
                {t('settings.mcp.detail.lastError')} ·{' '}
                {new Date(server.lastError.at).toLocaleString()}
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                {server.lastError.message}
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
            onSetToolEnabled={(tool, enabled) => onSetToolEnabled(server, tool, enabled)}
          />
        </section>

        {/* ── Resources ── */}
        <section ref={registerSection('resources')} className="space-y-2">
          <SectionTitle title={t('settings.mcp.detail.resources')} />
          <ResourcesBlock resources={resources} failed={resourcesFailed} onRetry={loadResources} />
        </section>

        {/* ── Auth ── */}
        {server.transport === 'http' && (
          <section ref={registerSection('auth')} className="space-y-2">
            <SectionTitle title={t('settings.mcp.detail.auth')} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <Row
                label={t('settings.mcp.detail.credentials')}
                value={
                  server.hasCredentials ? t('settings.mcp.detail.yes') : t('settings.mcp.detail.no')
                }
              />
              <Row label={t('settings.mcp.detail.state')} value={t(mcpStateKey(state))} />
            </dl>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => onLogin(server)}>
                <LogIn size={13} />
                {t('settings.mcp.action.login')}
              </Button>
              {server.hasCredentials && (
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
          {rawYaml === undefined ? (
            <p className="text-xs text-neutral-400">{t('common.loading')}</p>
          ) : rawYaml === null ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.mcp.detail.rawConfigUnavailable')}
            </p>
          ) : (
            <pre className="max-h-64 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
              {rawYaml}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}

/** Read-only list of a server's resources and templates, with one message per state. */
function ResourcesBlock({
  resources,
  failed,
  onRetry,
}: {
  resources: McpResourcesResponse | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation('common');

  if (failed) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-red-600 dark:text-red-400">
          {t('settings.mcp.detail.resourcesError')}
        </p>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (resources === null) {
    return <p className="text-xs text-neutral-400">{t('common.loading')}</p>;
  }
  if (!resources.supported) {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('settings.mcp.detail.resourcesNotSupported')}
      </p>
    );
  }
  if (!resources.connected) {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('settings.mcp.detail.resourcesNotConnected')}
      </p>
    );
  }
  if (resources.resources.length === 0) {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('settings.mcp.detail.resourcesEmpty')}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {resources.resources.map((item, i) => (
        <ResourceRow
          key={`${item.uri ?? item.uriTemplate ?? item.name ?? 'resource'}-${i}`}
          item={item}
        />
      ))}
    </ul>
  );
}

function ResourceRow({ item }: { item: McpResourceView }) {
  const { t } = useTranslation('common');
  const label = item.title || item.name || item.uri || item.uriTemplate || '—';
  return (
    <li className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">
          {label}
        </span>
        {item.template && (
          <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] leading-none text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            {t('settings.mcp.detail.resourceTemplate')}
          </span>
        )}
        {item.mimeType && (
          <span className="rounded border border-neutral-200 px-1.5 py-0.5 font-mono text-[10px] leading-none text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            {item.mimeType}
          </span>
        )}
      </div>
      <p className="mt-0.5 break-all font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
        {item.uri ?? item.uriTemplate ?? '—'}
      </p>
      {item.description && (
        <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
          {item.description}
        </p>
      )}
    </li>
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
