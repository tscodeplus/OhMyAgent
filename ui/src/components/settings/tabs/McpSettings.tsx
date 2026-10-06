// ---------------------------------------------------------------------------
// MCP settings tab (§13.0 – §13.12)
// ---------------------------------------------------------------------------
//
// Sidebar placement is declared in `SettingsModal.SETTINGS_GROUPS`: this tab is
// the last entry of the `integration` group, right below "Computer Use".
//
// Unlike the other settings tabs this one is NOT part of the imperative
// form + Save dirty model (decision D11, §13.8): install / uninstall / enable /
// disable are immediate, independent actions against `/api/mcp/*`, which writes
// `config.yaml` and hot-reloads it. The tab therefore registers no
// `SettingsTabHandle` with the modal.
//
// It is also the single owner of every MCP action (install, uninstall, toggle,
// login, exposure patches); the child components stay presentational, which
// keeps the optimistic-update + rollback logic in one place.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plug, Plus, Search, Server, Settings2 } from 'lucide-react';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Modal from '../../ui/Modal';
import Spinner from '../../ui/Spinner';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import { copyTextToClipboard } from '../../../utils/clipboard';
import McpServerCard, {
  type McpDetailSection,
  type McpExposure,
  type McpPreset,
  type McpServerView,
  type McpStatusView,
  type McpToolView,
} from '../mcp/McpServerCard';
import McpServerDetail from '../mcp/McpServerDetail';
import McpServerForm, {
  emptyMcpDraft,
  mcpDraftFromConfig,
  mcpDraftFromPreset,
  type McpServerDraft,
} from '../mcp/McpServerForm';
import McpPresetList from '../mcp/McpPresetList';

/** Delay before re-reading state after an action that (re)connects a server. */
const RECONNECT_SETTLE_MS = 1500;

/** Internal sub-tabs: global tunables first; the server list is the main working view. */
const MCP_SUB_TABS = [
  { id: 'settings' as const, icon: Settings2, labelKey: 'settings.mcp.subTabs.settings' },
  { id: 'servers' as const, icon: Server, labelKey: 'settings.mcp.subTabs.servers' },
];
type McpSubTab = (typeof MCP_SUB_TABS)[number]['id'];

/** One entry of the uninstall/disable impact scan (§13.4). */
interface ImpactScan {
  server: McpServerView;
  /** Referencing skill names; `null` while the scan is still running. */
  skills: string[] | null;
  allowList: boolean;
  denyList: boolean;
}

export default function McpSettings() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [status, setStatus] = useState<McpStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');

  const [toolsByName, setToolsByName] = useState<Record<string, McpToolView[] | undefined>>({});
  const [busyServer, setBusyServer] = useState<string | null>(null);
  const [pendingTool, setPendingTool] = useState<string | null>(null);

  const [detail, setDetail] = useState<{ name: string; section: McpDetailSection } | null>(null);
  const [form, setForm] = useState<{ editing: McpServerView | null; draft: McpServerDraft } | null>(
    null,
  );
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [uninstall, setUninstall] = useState<ImpactScan | null>(null);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [purgeCredentials, setPurgeCredentials] = useState(true);
  const [disableConfirm, setDisableConfirm] = useState<{
    server: McpServerView;
    skills: string[];
  } | null>(null);
  const [login, setLogin] = useState<{ server: McpServerView; url: string } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [activeSubTab, setActiveSubTab] = useState<McpSubTab>('servers');

  // Section-level tunable (`mcp.connect_timeout_sec`): loaded with the rest,
  // edited inline and PATCHed immediately (this tab has no Save-bar).
  const [connectTimeoutSec, setConnectTimeoutSec] = useState('');
  const [connectTimeoutError, setConnectTimeoutError] = useState<string | undefined>(undefined);
  const [savingConnectTimeout, setSavingConnectTimeout] = useState(false);

  const timersRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
    },
    [],
  );

  // ── Data loading ──

  const loadTools = useCallback((name: string) => {
    apiRequest<McpToolView[]>(`/api/mcp/servers/${encodeURIComponent(name)}/tools`)
      .then((list) => setToolsByName((prev) => ({ ...prev, [name]: list })))
      .catch(() => setToolsByName((prev) => ({ ...prev, [name]: [] })));
  }, []);

  const refresh = useCallback(
    (showLoading = true) => {
      if (showLoading) {
        setLoading(true);
        setLoadError(false);
      }
      Promise.all([
        apiRequest<McpServerView[]>('/api/mcp/servers'),
        apiRequest<McpStatusView>('/api/mcp/status'),
        apiRequest<{ connectTimeoutSec: number }>('/api/mcp/settings'),
      ])
        .then(([serverList, statusView, settings]) => {
          setServers(serverList);
          setStatus(statusView);
          setConnectTimeoutSec(String(settings.connectTimeoutSec));
          setConnectTimeoutError(undefined);
          setLoadError(false);
          // Tool lists are fetched per server so that NOT-registered (`hidden`)
          // tools stay visible and changeable — the route serves the manager
          // cache, which is exactly why it must be used instead of the registry
          // (§13.7). It also lets the search box match tool names.
          serverList.forEach((s) => loadTools(s.name));
        })
        .catch(() => setLoadError(true))
        .finally(() => setLoading(false));
    },
    [loadTools],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Re-read state shortly after an action that connects a server in the background. */
  const scheduleRefresh = useCallback(() => {
    const id = window.setTimeout(() => refresh(false), RECONNECT_SETTLE_MS);
    timersRef.current.push(id);
  }, [refresh]);

  /**
   * Write `mcp.connect_timeout_sec`; the gateway hot-reloads it server-side.
   * An emptied field PATCHes no key at all — the server then deletes the YAML
   * entry and the loader falls back to the default (restoring it, §13.3).
   */
  const saveConnectTimeout = useCallback(async () => {
    const raw = connectTimeoutSec.trim();
    const cleared = raw === '';
    if (!cleared && !/^[1-9]\d*$/.test(raw)) {
      setConnectTimeoutError(t('settings.mcp.connectTimeout.invalid'));
      return;
    }
    setConnectTimeoutError(undefined);
    setSavingConnectTimeout(true);
    try {
      await apiRequest<{ ok: boolean }>('/api/mcp/settings', {
        method: 'PATCH',
        body: JSON.stringify(cleared ? {} : { connectTimeoutSec: Number(raw) }),
      });
      showToast(t('settings.saved'), 'success');
      refresh(false);
    } catch (err) {
      showToast(errorText(err) || t('settings.saveError'), 'error', 6000);
    } finally {
      setSavingConnectTimeout(false);
    }
  }, [connectTimeoutSec, refresh, showToast, t]);

  // ── Skill / config impact scan (§13.4) ──

  /**
   * Best-effort map of `server name → skills referencing mcp__<server>__*`.
   *
   * The UI cannot import `matchesToolPattern()` (§12.2) from `src/`, so the
   * scan matches the `mcp__<server>__` prefix inside a SKILL.md frontmatter —
   * which covers both the exact name and the trailing-`*` wildcard form. A
   * mention in the skill body is not a tool reference and is not scanned.
   */
  const loadSkillRefs = useCallback(async (): Promise<Record<string, string[]>> => {
    try {
      const list = await apiRequest<{ skills: Array<{ slug: string; name: string }> }>(
        '/api/skills',
      );
      const contents = await Promise.all(
        (list.skills ?? []).map(async (skill) => {
          try {
            const detailResponse = await apiRequest<{ content?: string }>(
              `/api/skills/${encodeURIComponent(skill.slug)}`,
            );
            return detailResponse.content ?? '';
          } catch {
            return '';
          }
        }),
      );
      const refs: Record<string, string[]> = {};
      (list.skills ?? []).forEach((skill, i) => {
        const frontmatter = extractFrontmatter(contents[i] ?? '');
        for (const match of frontmatter.matchAll(/mcp__([A-Za-z0-9_-]+)__/g)) {
          const server = match[1];
          refs[server] = [...(refs[server] ?? []), skill.name || skill.slug];
        }
      });
      return refs;
    } catch {
      // The scan is advisory — a failure must never block uninstall/disable.
      return {};
    }
  }, []);

  const loadConfig = useCallback(async (): Promise<Record<string, unknown> | null> => {
    try {
      return await apiRequest<Record<string, unknown>>('/api/config');
    } catch {
      return null;
    }
  }, []);

  const buildImpact = useCallback(
    async (server: McpServerView): Promise<ImpactScan> => {
      const [refs, config] = await Promise.all([loadSkillRefs(), loadConfig()]);
      const mcp = (config?.mcp ?? {}) as { allowServers?: string[]; denyServers?: string[] };
      return {
        server,
        skills: refs[server.name] ?? [],
        allowList: (mcp.allowServers ?? []).includes(server.name),
        denyList: (mcp.denyServers ?? []).includes(server.name),
      };
    },
    [loadSkillRefs, loadConfig],
  );

  // ── Actions ──

  const applyToggle = useCallback(
    async (server: McpServerView, enabled: boolean) => {
      const snapshot = servers;
      // Optimistic: flip immediately, roll back if the route rejects (§13.5).
      setServers(
        (prev) =>
          prev?.map((s) =>
            s.name === server.name
              ? { ...s, enabled, state: enabled ? 'connecting' : 'disabled' }
              : s,
          ) ?? prev,
      );
      setBusyServer(server.name);
      try {
        const result = await apiRequest<{ ok: boolean; server: McpServerView }>(
          `/api/mcp/servers/${encodeURIComponent(server.name)}`,
          { method: 'PATCH', body: JSON.stringify({ enabled }) },
        );
        setServers(
          (prev) => prev?.map((s) => (s.name === server.name ? result.server : s)) ?? prev,
        );
        showToast(t('settings.mcp.notice.toolsetUpdated'), 'info');
        loadTools(server.name);
        scheduleRefresh();
      } catch (err) {
        setServers(snapshot);
        showToast(errorText(err) || t('settings.saveError'), 'error', 6000);
      } finally {
        setBusyServer(null);
      }
    },
    [servers, showToast, t, loadTools, scheduleRefresh],
  );

  const handleToggle = useCallback(
    async (server: McpServerView, enabled: boolean) => {
      if (enabled) {
        await applyToggle(server, true);
        return;
      }
      // Disabling takes the tools away from the model; if a skill references
      // them, ask first (§13.5).
      const impact = await buildImpact(server);
      if ((impact.skills ?? []).length > 0)
        setDisableConfirm({ server, skills: impact.skills ?? [] });
      else await applyToggle(server, false);
    },
    [applyToggle, buildImpact],
  );

  const handleReconnect = useCallback(
    async (server: McpServerView) => {
      setBusyServer(server.name);
      try {
        await apiRequest(`/api/mcp/servers/${encodeURIComponent(server.name)}/reconnect`, {
          method: 'POST',
          timeoutMs: 60_000,
        });
        showToast(t('settings.mcp.notice.reconnected', { name: server.name }), 'info');
        loadTools(server.name);
        scheduleRefresh();
      } catch (err) {
        showToast(errorText(err) || t('settings.mcp.state.error'), 'error', 6000);
      } finally {
        setBusyServer(null);
      }
    },
    [showToast, t, loadTools, scheduleRefresh],
  );

  const handleLogin = useCallback(
    async (server: McpServerView) => {
      setBusyServer(server.name);
      try {
        const result = await apiRequest<{ ok: boolean; authorizationUrl: string }>(
          `/api/mcp/servers/${encodeURIComponent(server.name)}/login`,
          { method: 'POST', timeoutMs: 60_000 },
        );
        if (!result.authorizationUrl) {
          showToast(t('common.error'), 'error', 6000);
          return;
        }
        // Open the browser, but also show the URL: on headless installs
        // (Termux / remote gateway) the popup cannot reach the user's device.
        window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
        setCallbackUrl('');
        setLogin({ server, url: result.authorizationUrl });
      } catch (err) {
        showToast(errorText(err) || t('settings.mcp.state.error'), 'error', 6000);
      } finally {
        setBusyServer(null);
      }
    },
    [showToast, t],
  );

  const submitCallback = useCallback(async () => {
    if (!login || !callbackUrl.trim()) return;
    setLoginBusy(true);
    try {
      await apiRequest(`/api/mcp/servers/${encodeURIComponent(login.server.name)}/login/callback`, {
        method: 'POST',
        body: JSON.stringify({ callbackUrl: callbackUrl.trim() }),
      });
      showToast(t('settings.mcp.notice.loggedIn', { name: login.server.name }), 'success');
      setLogin(null);
      scheduleRefresh();
    } catch (err) {
      showToast(errorText(err) || t('settings.mcp.state.error'), 'error', 6000);
    } finally {
      setLoginBusy(false);
    }
  }, [login, callbackUrl, showToast, t, scheduleRefresh]);

  const handleLogout = useCallback(
    async (server: McpServerView) => {
      setBusyServer(server.name);
      try {
        await apiRequest(`/api/mcp/servers/${encodeURIComponent(server.name)}/logout`, {
          method: 'POST',
        });
        showToast(t('settings.mcp.notice.loggedOut', { name: server.name }), 'info');
        scheduleRefresh();
      } catch (err) {
        showToast(errorText(err) || t('settings.mcp.state.error'), 'error', 6000);
      } finally {
        setBusyServer(null);
      }
    },
    [showToast, t, scheduleRefresh],
  );

  const handleEdit = useCallback(
    async (server: McpServerView) => {
      setBusyServer(server.name);
      try {
        // env/header values are masked and only available through /api/config.
        const config = await apiRequest<Record<string, unknown>>('/api/config');
        setForm({ editing: server, draft: mcpDraftFromConfig(server, config) });
      } catch {
        showToast(t('settings.loadError'), 'error', 6000);
      } finally {
        setBusyServer(null);
      }
    },
    [showToast, t],
  );

  const handleUninstall = useCallback(
    async (server: McpServerView) => {
      setPurgeCredentials(Boolean(server.hasCredentials));
      setUninstall({ server, skills: null, allowList: false, denyList: false });
      const impact = await buildImpact(server);
      setUninstall((current) =>
        current && current.server.name === impact.server.name ? impact : current,
      );
    },
    [buildImpact],
  );

  const confirmUninstall = useCallback(async () => {
    if (!uninstall) return;
    setUninstallBusy(true);
    try {
      const result = await apiRequest<{ ok: boolean; removedTools: number }>(
        `/api/mcp/servers/${encodeURIComponent(uninstall.server.name)}?purge_credentials=${
          purgeCredentials ? 'true' : 'false'
        }`,
        { method: 'DELETE' },
      );
      showToast(
        t('settings.mcp.notice.uninstalled', {
          name: uninstall.server.name,
          count: result.removedTools ?? 0,
        }),
        'success',
      );
      setUninstall(null);
      refresh(false);
    } catch (err) {
      showToast(errorText(err) || t('settings.saveError'), 'error', 6000);
    } finally {
      setUninstallBusy(false);
    }
  }, [uninstall, purgeCredentials, showToast, t, refresh]);

  const handleSetToolExposure = useCallback(
    async (server: McpServerView, tool: McpToolView, exposure: McpExposure) => {
      const snapshot = toolsByName[server.name];
      setPendingTool(tool.name);
      setToolsByName((prev) => ({
        ...prev,
        [server.name]: (prev[server.name] ?? []).map((item) =>
          item.name === tool.name ? { ...item, exposure } : item,
        ),
      }));
      try {
        // `tool_exposure` keys are the server-side tool names — see the §5.1
        // examples (`read_file: direct`, `write_*: hidden`); the registered
        // name carries the `mcp__<server>__` prefix.
        const result = await apiRequest<{ ok: boolean; server: McpServerView }>(
          `/api/mcp/servers/${encodeURIComponent(server.name)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              tool_exposure: { ...server.toolExposure, [tool.serverToolName]: exposure },
            }),
          },
        );
        setServers(
          (prev) => prev?.map((s) => (s.name === server.name ? result.server : s)) ?? prev,
        );
        showToast(t('settings.mcp.notice.toolsetUpdated'), 'info');
        loadTools(server.name);
      } catch (err) {
        if (snapshot) setToolsByName((prev) => ({ ...prev, [server.name]: snapshot }));
        else loadTools(server.name);
        showToast(errorText(err) || t('settings.saveError'), 'error', 6000);
      } finally {
        setPendingTool(null);
      }
    },
    [toolsByName, showToast, t, loadTools],
  );

  /**
   * Toggle one tool on/off (§13.6).
   *
   * `tool_enabled` is keyed by the *raw* server tool name (the same key
   * `tool_exposure` uses), and the PATCH merges per key — sending one entry
   * must not clear the others. A disabled tool stays in `GET .../tools` so it
   * can be switched back on; it is simply not registered for the model.
   */
  const handleSetToolEnabled = useCallback(
    async (server: McpServerView, tool: McpToolView, enabled: boolean) => {
      const snapshot = toolsByName[server.name];
      setPendingTool(tool.name);
      setToolsByName((prev) => ({
        ...prev,
        [server.name]: (prev[server.name] ?? []).map((item) =>
          item.name === tool.name ? { ...item, enabled } : item,
        ),
      }));
      try {
        const result = await apiRequest<{ ok: boolean; server: McpServerView }>(
          `/api/mcp/servers/${encodeURIComponent(server.name)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ tool_enabled: { [tool.serverToolName]: enabled } }),
          },
        );
        setServers(
          (prev) => prev?.map((s) => (s.name === server.name ? result.server : s)) ?? prev,
        );
        showToast(t('settings.mcp.notice.toolsetUpdated'), 'info');
        loadTools(server.name);
      } catch (err) {
        if (snapshot) setToolsByName((prev) => ({ ...prev, [server.name]: snapshot }));
        else loadTools(server.name);
        showToast(errorText(err) || t('settings.saveError'), 'error', 6000);
      } finally {
        setPendingTool(null);
      }
    },
    [toolsByName, showToast, t, loadTools],
  );

  // ── Derived ──

  const filtered = useMemo(() => {
    if (!servers) return [];
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter((server) => {
      if (server.name.toLowerCase().includes(q)) return true;
      if ((server.description ?? '').toLowerCase().includes(q)) return true;
      const tools = toolsByName[server.name] ?? [];
      return tools.some(
        (tool) =>
          tool.name.toLowerCase().includes(q) ||
          tool.serverToolName.toLowerCase().includes(q) ||
          (tool.description ?? '').toLowerCase().includes(q),
      );
    });
  }, [servers, query, toolsByName]);

  const detailServer = detail ? (servers?.find((s) => s.name === detail.name) ?? null) : null;

  const connectTimeoutBox = (
    <section className="rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="max-w-64">
        <Input
          label={t('settings.mcp.connectTimeout.label')}
          value={connectTimeoutSec}
          error={connectTimeoutError}
          placeholder="300"
          inputMode="numeric"
          disabled={loading}
          onChange={(e) => {
            setConnectTimeoutSec(e.target.value);
            setConnectTimeoutError(undefined);
          }}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {t('settings.mcp.connectTimeout.hint')}
        <span className="mx-1.5 text-neutral-300 dark:text-neutral-600">·</span>
        {t('settings.mcp.settingsNote')}
      </p>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          onClick={saveConnectTimeout}
          loading={savingConnectTimeout}
          disabled={loading}
        >
          {t('common.save')}
        </Button>
      </div>
    </section>
  );

  const settingsTab = <div className="space-y-3">{connectTimeoutBox}</div>;

  const openDetail = useCallback((server: McpServerView, section: McpDetailSection) => {
    setDetail({ name: server.name, section });
  }, []);

  // ── Render ──

  const header = (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">
          {t('settings.mcp.subtitle')}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPresetsOpen(true)}>
            {t('settings.mcp.installFromPreset')}
          </Button>
          <Button size="sm" onClick={() => setForm({ editing: null, draft: emptyMcpDraft() })}>
            <Plus size={13} />
            {t('settings.mcp.addServer')}
          </Button>
        </div>
      </div>
      {status && status.installed > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <StatusChip label={t('settings.mcp.chips.installed', { count: status.installed })} />
          <StatusChip
            label={t('settings.mcp.chips.connected', { count: status.connected })}
            tone="ok"
          />
          {status.authRequired > 0 && (
            <StatusChip
              label={t('settings.mcp.chips.needsLogin', { count: status.authRequired })}
              tone="warn"
            />
          )}
          {status.errorCount > 0 && (
            <StatusChip
              label={t('settings.mcp.chips.errors', { count: status.errorCount })}
              tone="danger"
            />
          )}
        </div>
      )}
      {(servers?.length ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 dark:border-neutral-800 dark:bg-neutral-800">
          <Search size={14} className="shrink-0 text-neutral-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.mcp.searchPlaceholder')}
            className="w-full bg-transparent text-sm text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100"
          />
        </div>
      )}
    </section>
  );

  let body: ReactNode;
  if (loading && !servers) {
    body = (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900"
          />
        ))}
      </div>
    );
  } else if (loadError) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-6 dark:border-red-900 dark:bg-red-950/30">
        <p className="text-sm text-red-700 dark:text-red-300">
          {t('settings.mcp.errors.loadFailed')}
        </p>
        <Button variant="secondary" size="sm" onClick={() => refresh()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  } else if ((servers?.length ?? 0) === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center dark:border-neutral-700">
        <Plug size={22} className="text-neutral-400" strokeWidth={1.5} />
        <div>
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {t('settings.mcp.empty.title')}
          </p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.mcp.empty.description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPresetsOpen(true)}>
            {t('settings.mcp.installFromPreset')}
          </Button>
          <Button size="sm" onClick={() => setForm({ editing: null, draft: emptyMcpDraft() })}>
            {t('settings.mcp.addManual')}
          </Button>
        </div>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <p className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
        {t('common.noData')}
      </p>
    );
  } else {
    body = (
      <div className="space-y-2">
        {filtered.map((server) => (
          <McpServerCard
            key={server.name}
            server={server}
            tools={toolsByName[server.name]}
            busy={busyServer === server.name}
            pendingTool={pendingTool}
            onToggle={handleToggle}
            onEdit={handleEdit}
            onOpenDetail={openDetail}
            onReconnect={handleReconnect}
            onLogin={handleLogin}
            onLogout={handleLogout}
            onUninstall={handleUninstall}
            onSetToolExposure={handleSetToolExposure}
            onSetToolEnabled={handleSetToolEnabled}
          />
        ))}
      </div>
    );
  }

  // Same segmented-control language as ModelSettings' sub-tab bar.
  const subTabBar = (
    <div
      className="flex max-sm:overflow-x-auto gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800"
      role="tablist"
    >
      {MCP_SUB_TABS.map((st) => {
        const Icon = st.icon;
        const active = activeSubTab === st.id;
        return (
          <button
            key={st.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setActiveSubTab(st.id)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] transition-all ${
              active
                ? 'bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
            }`}
          >
            <Icon size={14} strokeWidth={1.75} />
            <span>{t(st.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-4">
      {subTabBar}

      <div
        className="space-y-4"
        style={{ display: activeSubTab === 'servers' ? undefined : 'none' }}
      >
        {header}
        {body}
      </div>

      <div
        className="space-y-3"
        style={{ display: activeSubTab === 'settings' ? undefined : 'none' }}
      >
        {settingsTab}
      </div>

      {detail && detailServer && (
        <McpServerDetail
          server={detailServer}
          tools={toolsByName[detailServer.name]}
          pendingTool={pendingTool}
          initialSection={detail.section}
          onClose={() => setDetail(null)}
          onLogin={handleLogin}
          onLogout={handleLogout}
          onReconnect={handleReconnect}
          onSetToolExposure={handleSetToolExposure}
          onSetToolEnabled={handleSetToolEnabled}
        />
      )}

      {presetsOpen && (
        <McpPresetList
          installedNames={(servers ?? []).map((s) => s.name)}
          onClose={() => setPresetsOpen(false)}
          onManual={() => {
            setPresetsOpen(false);
            setForm({ editing: null, draft: emptyMcpDraft() });
          }}
          onPick={(preset: McpPreset) => {
            setPresetsOpen(false);
            setForm({ editing: null, draft: mcpDraftFromPreset(preset) });
          }}
        />
      )}

      {form && (
        <McpServerForm
          editing={form.editing}
          initial={form.draft}
          existingNames={(servers ?? []).map((s) => s.name)}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            showToast(t('settings.saved'), 'success');
            refresh(false);
          }}
        />
      )}

      {login && (
        <Modal
          open
          onClose={() => setLogin(null)}
          size="sm"
          title={t('settings.mcp.action.login')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setLogin(null)} disabled={loginBusy}>
                {t('common.close')}
              </Button>
              <Button onClick={submitCallback} loading={loginBusy} disabled={!callbackUrl.trim()}>
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.mcp.oauth.headlessHint')}
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={login.url}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-[11px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-300"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await copyTextToClipboard(login.url);
                }}
              >
                {t('common.copy')}
              </Button>
            </div>
            <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
              {t('settings.mcp.oauth.pasteCallbackUrl')}
            </label>
            <input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://127.0.0.1:8765/callback?code=..."
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-[11px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </div>
        </Modal>
      )}

      {uninstall && (
        <Modal
          open
          onClose={() => setUninstall(null)}
          size="sm"
          title={t('settings.mcp.confirm.uninstallTitle')}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setUninstall(null)}
                disabled={uninstallBusy}
              >
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={confirmUninstall} loading={uninstallBusy}>
                {t('settings.mcp.action.uninstall')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              {t('settings.mcp.confirm.uninstallBody', {
                name: uninstall.server.name,
                transport: t(`settings.mcp.transport.${uninstall.server.transport}`),
                count: uninstall.server.toolCount,
              })}
            </p>
            <ImpactBlock impact={uninstall} />
            {uninstall.server.hasCredentials && (
              <label className="flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={purgeCredentials}
                  onChange={(e) => setPurgeCredentials(e.target.checked)}
                />
                {t('settings.mcp.confirm.purgeCredentials')}
              </label>
            )}
          </div>
        </Modal>
      )}

      {disableConfirm && (
        <Modal
          open
          onClose={() => setDisableConfirm(null)}
          size="sm"
          title={t('settings.mcp.confirm.disableTitle')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDisableConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  const target = disableConfirm.server;
                  setDisableConfirm(null);
                  applyToggle(target, false);
                }}
                loading={busyServer === disableConfirm.server.name}
              >
                {t('settings.mcp.disable')}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              {t('settings.mcp.confirm.disableBody', { name: disableConfirm.server.name })}
            </p>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <p>
                {t('settings.mcp.confirm.impactSkills', { server: disableConfirm.server.name })}
              </p>
              <ul className="mt-1 list-inside list-disc font-mono">
                {disableConfirm.skills.map((skill) => (
                  <li key={skill}>{skill}</li>
                ))}
              </ul>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Impact-scan lines shared by the uninstall dialog (§13.4). */
function ImpactBlock({ impact }: { impact: ImpactScan }) {
  const { t } = useTranslation('common');
  if (impact.skills === null) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <Spinner size="sm" />
        {t('settings.mcp.confirm.scanning')}
      </div>
    );
  }
  const empty = impact.skills.length === 0 && !impact.allowList && !impact.denyList;
  return (
    <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
      {impact.skills.length > 0 && (
        <>
          <p>{t('settings.mcp.confirm.impactSkills', { server: impact.server.name })}</p>
          <ul className="list-inside list-disc font-mono">
            {impact.skills.map((skill) => (
              <li key={skill}>{skill}</li>
            ))}
          </ul>
        </>
      )}
      {impact.allowList && (
        <p>{t('settings.mcp.confirm.impactAllowList', { server: impact.server.name })}</p>
      )}
      {impact.denyList && (
        <p>{t('settings.mcp.confirm.impactDenyList', { server: impact.server.name })}</p>
      )}
      {empty && <p>{t('settings.mcp.confirm.impactNone')}</p>}
    </div>
  );
}

/**
 * SKILL.md frontmatter block (everything before the closing `---`).
 *
 * `skill-loader.ts` requires the file to open with `---`; a file without it is
 * not a skill and is skipped by the scan.
 */
function extractFrontmatter(content: string): string {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('\n---', 3);
  return end === -1 ? '' : content.slice(0, end);
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return '';
}

/** Small count chip in the header. Colour is an extra signal, never the only one. */
function StatusChip({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}) {
  const cls = {
    neutral: 'border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300',
    ok: 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300',
    warn: 'border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-300',
    danger: 'border-red-200 text-red-700 dark:border-red-900 dark:text-red-300',
  }[tone];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${cls}`}>
      {label}
    </span>
  );
}
