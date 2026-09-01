import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Info, Bot, Cpu, Workflow, Share2, Globe, Image as ImageIcon, Monitor, Wrench, BrainCircuit, Network, SlidersHorizontal, Settings2, Plug, AlertCircle, type LucideIcon } from 'lucide-react';
import SettingsSidebar from './SettingsSidebar';
import SettingsSearch from './SettingsSearch';
import GeneralSettings from './tabs/GeneralSettings';
import ModelSettings from './tabs/ModelSettings';
import ChannelsSettings from './tabs/ChannelsSettings';
import AgentSettings from './tabs/AgentSettings';
import ToolsPolicySettings from './tabs/ToolsPolicySettings';
import WebSearchSettings from './tabs/WebSearchSettings';
import MemorySettings from './tabs/MemorySettings';
import MultimodalSettings from './tabs/MultimodalSettings';
import ComputerUseSettings from './tabs/ComputerUseSettings';
import DesktopSettings from './tabs/DesktopSettings';
import GatewaySettings from './tabs/GatewaySettings';
import HarnessSettings from './tabs/HarnessSettings';
import { isElectron } from '../../utils/env';
import { getToken } from '../../utils/api';
import Button from '../ui/Button';
import { useToast, type ToastAction } from '../ui/Toast';
import type { SettingsTabHandle } from './useConfigDirty';

/**
 * Settings tabs whose changes require a service restart to take effect.
 * These tabs configure long-lived connections (channel clients, embedding
 * client, STT provider, SSH pools) that are created once at boot and cannot
 * be hot-swapped.
 */
/** Tabs where ALL settings need restart — no per-field granularity needed. */
const RESTART_REQUIRED_TABS = new Set([
  'channels',
  'computer',
  'gateway',
]);

/** Returns true if one-click restart is available (Electron desktop). */
function canRestartService(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.electronAPI?.restartService === 'function';
}

/** Give up polling /api/health after this long and report failure. */
const RESTART_POLL_TIMEOUT_MS = 90_000;

/** Poll /api/health (public, auth-exempt) until the restarted server is back. */
async function waitUntilHealthy(): Promise<boolean> {
  const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;
  let sawDown = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const health = await fetch('/api/health', { cache: 'no-store' });
      if (health.ok) {
        // Desktop: the shell IPC returns before the old sidecar is even
        // killed, so an early OK may still be the OLD process. Only trust
        // a success once we have seen the server go down.
        if (sawDown) return true;
        continue;
      }
    } catch {
      // Server restarting — expected, keep polling
    }
    sawDown = true;
  }
  return false;
}

interface SettingsModalProps {
  onClose: () => void;
  /** Open directly on this tab (e.g. deep-links from chat selectors). */
  initialTab?: string;
  /** Optional sub-tab inside initialTab (e.g. 'providers' in 'models'). */
  initialSubTab?: string;
}

export type SettingsGroupId = 'general' | 'agent' | 'integration' | 'system';

export interface SettingsTabDef {
  id: string;
  labelKey: string;
  group: SettingsGroupId;
  icon: LucideIcon;
}

/** Sidebar tab order + 4-group clustering (P3). */
export const SETTINGS_GROUPS: readonly SettingsTabDef[] = [
  // ── 📌 常规 ──
  { id: 'general', labelKey: 'settings.groups.general', group: 'general', icon: SlidersHorizontal },
  // ── 🤖 智能体 ──
  { id: 'models', labelKey: 'settings.groups.models', group: 'agent', icon: Cpu },
  { id: 'agents', labelKey: 'settings.groups.agents', group: 'agent', icon: Bot },
  { id: 'harness', labelKey: 'settings.groups.harness', group: 'agent', icon: Workflow },
  // ── 🔌 集成 ──
  { id: 'channels', labelKey: 'settings.groups.channels', group: 'integration', icon: Share2 },
  { id: 'websearch', labelKey: 'settings.groups.websearch', group: 'integration', icon: Globe },
  { id: 'multimodal', labelKey: 'settings.groups.multimodal', group: 'integration', icon: ImageIcon },
  { id: 'computer', labelKey: 'settings.groups.computer', group: 'integration', icon: Monitor },
  // ── ⚙️ 系统 ──
  { id: 'tools', labelKey: 'settings.groups.toolsPolicy', group: 'system', icon: Wrench },
  { id: 'memory', labelKey: 'settings.groups.memory', group: 'system', icon: BrainCircuit },
  { id: 'gateway', labelKey: 'settings.groups.gateway', group: 'system', icon: Network },
  { id: 'about', labelKey: 'settings.groups.about', group: 'system', icon: Info },
] as const;

/** Group titles shown as section headers in the sidebar / <optgroup> on mobile. */
export const SETTINGS_GROUP_DEFS: Record<SettingsGroupId, { labelKey: string; icon: LucideIcon }> = {
  general: { labelKey: 'settings.groups.groupGeneral', icon: Settings2 },
  agent: { labelKey: 'settings.groups.groupAgent', icon: Bot },
  integration: { labelKey: 'settings.groups.groupIntegration', icon: Plug },
  system: { labelKey: 'settings.groups.groupSystem', icon: Settings2 },
};

const COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  general: GeneralSettings,
  models: ModelSettings,
  channels: ChannelsSettings,
  agents: AgentSettings,
  harness: HarnessSettings,
  tools: ToolsPolicySettings,
  websearch: WebSearchSettings,
  memory: MemorySettings,
  multimodal: MultimodalSettings,
  computer: ComputerUseSettings,
  gateway: GatewaySettings,
  about: DesktopSettings,
};

export default function SettingsModal({ onClose, initialTab, initialSubTab }: SettingsModalProps) {
  const { t } = useTranslation('common');
  const { showToast, dismissToast } = useToast();
  const [activeGroup, setActiveGroup] = useState<string>(initialTab || 'general');
  const [modelSubTab, setModelSubTab] = useState<string | undefined>(initialSubTab);

  // Re-sync when the requested tab changes while the modal is open
  // (e.g. opening the modal twice in one session with different tabs).
  useEffect(() => {
    if (initialTab) setActiveGroup(initialTab);
    if (initialSubTab) setModelSubTab(initialSubTab);
  }, [initialTab, initialSubTab]);
  const [saving, setSaving] = useState(false);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const [restartRequiredTabs, setRestartRequiredTabs] = useState<Set<string>>(new Set());
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  // Track which tabs have been visited so they stay mounted (preserves dirty state).
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(new Set(['general']));

  // Map of tabId → handle for all tabs that support save/cancel.
  const tabHandles = useRef<Map<string, SettingsTabHandle>>(new Map());

  // Mark current tab as mounted whenever activeGroup changes.
  useEffect(() => {
    setMountedTabs(prev => {
      if (prev.has(activeGroup)) return prev;
      return new Set([...prev, activeGroup]);
    });
  }, [activeGroup]);

  const visibleGroups = SETTINGS_GROUPS.filter(
    (g) => g.id !== 'gateway' || isElectron(),
  );

  // If currently on a gateway tab and not in Electron, fall back to general
  if (!isElectron() && activeGroup === 'gateway') {
    setActiveGroup('general');
  }

  // Called by each tab to register/unregister its handle
  const registerHandle = useCallback((tabId: string, handle: SettingsTabHandle | null) => {
    if (handle) {
      tabHandles.current.set(tabId, handle);
    } else {
      tabHandles.current.delete(tabId);
    }
  }, []);

  // Called by each tab to report dirty state changes.
  // IMPORTANT: return the previous reference when nothing changed — otherwise
  // a tab that reports dirty state on every render (e.g. one passing an inline
  // onDirtyChange to useConfigDirty) would force a new Set every time and spin
  // React in an endless re-render loop.
  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setDirtyTabs(prev => {
      const has = prev.has(tabId);
      if (has === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId); else next.delete(tabId);
      return next;
    });
  }, []);

  const hasGlobalDirty = dirtyTabs.size > 0;

  const handleRestart = useCallback(async () => {
    if (!canRestartService()) return;

    // The shell restarts only the sidecar — the WebView itself stays alive,
    // so nothing reloads on its own. Keep a sticky progress toast up, then
    // poll /api/health until the new sidecar answers and reload the page so
    // AppShell confirms with the same "service restarted" toast as the
    // WebUI flow.
    const progressToastId = showToast(t('settings.restarting'), 'info', 0);
    const failToast = (message: string) => {
      dismissToast(progressToastId);
      showToast(message, 'error', 6000);
    };
    try {
      const result = await window.electronAPI!.restartService();
      if (!result?.ok) {
        failToast(result?.error || t('settings.restartFailed'));
        return;
      }
      try { sessionStorage.setItem('ohmyagent_restarted', '1'); } catch { /* noop */ }
      if (await waitUntilHealthy()) {
        window.location.reload();
        return;
      }
      failToast(t('settings.restartFailed'));
    } catch {
      failToast(t('settings.restartFailed'));
    }
  }, [showToast, dismissToast, t]);

  // WebUI (browser): restart via the server API. The server picks the right
  // strategy for how it was started — service managers (runit/launchd/
  // systemd/schtasks) or replaying the original command line (pnpm dev,
  // ohmyagent start, …). Desktop-shell instances are rejected (409) and fall
  // back to the info toast, because only the shell can restart its sidecar.
  // NOTE: the request must carry the WebUI token (same as perform-update) —
  // a bare fetch gets 401 from webuiAuthHook and the restart never happens.
  const handleServerRestart = useCallback(async () => {
    const progressToastId = showToast(t('settings.restarting'), 'info', 0);
    /** Replace the sticky progress toast with a timed one. */
    const swapToast = (message: string, type: 'info' | 'error') => {
      dismissToast(progressToastId);
      showToast(message, type, 6000);
    };
    try {
      const token = getToken();
      const res = await fetch('/api/system/restart', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        swapToast(t('settings.restartNeeded'), 'info');
        return;
      }
      try { sessionStorage.setItem('ohmyagent_restarted', '1'); } catch { /* noop */ }
      // The server goes down for a moment — poll until it is back, then
      // reload so the UI reconnects with fresh state.
      if (await waitUntilHealthy()) {
        window.location.reload();
        return;
      }
      swapToast(t('settings.restartFailed'), 'error');
    } catch {
      swapToast(t('settings.restartFailed'), 'error');
    }
  }, [showToast, dismissToast, t]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    let savedCount = 0;
    let needsRestart = false;
    try {
      // Save ALL dirty tabs silently, then show one toast
      for (const tabId of dirtyTabs) {
        const handle = tabHandles.current.get(tabId);
        if (handle?.isDirty()) {
          await handle.save({ silent: true });
          savedCount++;
          if (handle.needsRestart?.() ?? RESTART_REQUIRED_TABS.has(tabId)) {
            needsRestart = true;
            setRestartRequiredTabs(prev => new Set([...prev, tabId]));
          }
        }
      }
      if (savedCount > 0) {
        if (needsRestart) {
          // Both desktop and WebUI get a restart action; the button renders
          // bottom-right of the toast. Desktop uses the shell IPC, WebUI
          // goes through the server-side restart endpoint.
          const restartNow: ToastAction = {
            label: t('settings.restartNow'),
            onClick: canRestartService() ? handleRestart : handleServerRestart,
          };
          showToast(t('settings.restartNeeded'), 'info', 0, [restartNow]);
        } else {
          showToast(t('settings.saved'), 'success');
        }
      }
    } catch {
      // Error toast already shown by individual save
    } finally {
      setSaving(false);
    }
  }, [dirtyTabs, showToast, t, handleRestart, handleServerRestart]);

  const handleCancel = useCallback(() => {
    // Cancel ALL registered tabs
    for (const handle of tabHandles.current.values()) {
      handle.cancel();
    }
  }, []);

  const handleClose = useCallback(() => {
    if (hasGlobalDirty) {
      setShowCloseConfirm(true);
    } else {
      onClose();
    }
  }, [hasGlobalDirty, onClose]);

  // Shared dialog actions (cancel/save/close) — desktop keeps them in the
  // content header; phones render them inline beside the section picker.
  const dialogActions = (
    <div className="flex items-center gap-1.5 shrink-0">
      <Button variant="secondary" size="sm" onClick={handleCancel}>
        {t('common.cancel')}
      </Button>
      <Button
        variant={hasGlobalDirty ? 'danger' : 'primary'}
        size="sm"
        onClick={handleSave}
        loading={saving}
      >
        {t('settings.save')}
      </Button>
      <button
        onClick={handleClose}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <X className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );

  // Tab switching is always allowed — no confirmation.
  const handleSidebarSelect = useCallback((id: string) => {
    setActiveGroup(id);
  }, []);

  // ── Render helpers ──

  const tabProps = { registerHandle, onDirtyChange: handleDirtyChange };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 max-sm:p-0 sm:p-4 backdrop-blur-sm">
      <div className="relative flex max-sm:flex-col h-[85vh] max-sm:h-full max-sm:max-h-full w-full max-w-4xl max-sm:max-w-none overflow-hidden rounded-xl max-sm:rounded-none border border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-950">
        {/* Side nav */}
        <div className="flex w-[180px] max-sm:w-full max-sm:h-auto shrink-0 flex-col border-r max-sm:border-r-0 max-sm:border-b border-neutral-200 bg-neutral-50/80 dark:border-neutral-800 dark:bg-neutral-900/50">
          <div className="flex h-12 max-sm:h-9 items-center px-4 max-sm:px-3 border-b max-sm:border-b-0 max-sm:hidden border-neutral-200 dark:border-neutral-800 shrink-0">
            <h2 className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100 whitespace-nowrap">
              {t('settings.title')}
            </h2>
          </div>
          <SettingsSidebar
            groups={visibleGroups}
            activeGroup={activeGroup}
            onSelect={handleSidebarSelect}
            dirtyTabs={dirtyTabs}
            mobileActions={dialogActions}
          />
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          {/* Desktop-only content header — phones fold the actions into the
              picker row above instead, so the group name isn't shown twice. */}
          <div className="hidden sm:flex h-12 items-center justify-between gap-3 px-6 border-b border-neutral-200 dark:border-neutral-800">
            <h3 className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300 truncate">
              {t(visibleGroups.find(g => g.id === activeGroup)?.labelKey || '')}
            </h3>
            <div className="flex items-center gap-2">
              <SettingsSearch onSelect={(tabId, subTabId) => { setActiveGroup(tabId); if (subTabId) setModelSubTab(subTabId); }} />
              {dialogActions}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6 max-sm:p-4">
            {/* Restart-required banner */}
            {restartRequiredTabs.size > 0 && (
              <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-4 dark:border-amber-800 dark:bg-amber-900/20">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    {t('settings.restartNeeded')}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={canRestartService() ? handleRestart : handleServerRestart}>
                  {t('settings.restartNow')}
                </Button>
              </div>
            )}
            {/* Tabs that support save/cancel stay mounted once visited */}
            {mountedTabs.has('general') && (
              <div style={{ display: activeGroup === 'general' ? undefined : 'none' }}>
                <GeneralSettings tabId="general" {...tabProps} />
              </div>
            )}
            {mountedTabs.has('models') && (
              <div style={{ display: activeGroup === 'models' ? undefined : 'none' }}>
                <ModelSettings {...tabProps} initialSubTab={modelSubTab} />
              </div>
            )}
            {mountedTabs.has('channels') && (
              <div style={{ display: activeGroup === 'channels' ? undefined : 'none' }}>
                <ChannelsSettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('agents') && (
              <div style={{ display: activeGroup === 'agents' ? undefined : 'none' }}>
                <AgentSettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('harness') && (
              <div style={{ display: activeGroup === 'harness' ? undefined : 'none' }}>
                <HarnessSettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('tools') && (
              <div style={{ display: activeGroup === 'tools' ? undefined : 'none' }}>
                <ToolsPolicySettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('websearch') && (
              <div style={{ display: activeGroup === 'websearch' ? undefined : 'none' }}>
                <WebSearchSettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('memory') && (
              <div style={{ display: activeGroup === 'memory' ? undefined : 'none' }}>
                <MemorySettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('multimodal') && (
              <div style={{ display: activeGroup === 'multimodal' ? undefined : 'none' }}>
                <MultimodalSettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('computer') && (
              <div style={{ display: activeGroup === 'computer' ? undefined : 'none' }}>
                <ComputerUseSettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('gateway') && (
              <div style={{ display: activeGroup === 'gateway' ? undefined : 'none' }}>
                <GatewaySettings {...tabProps} />
              </div>
            )}
            {mountedTabs.has('about') && (
              <div style={{ display: activeGroup === 'about' ? undefined : 'none' }}>
                <DesktopSettings />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Close confirmation dialog ── */}
      {showCloseConfirm && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 shadow-xl p-6 max-w-sm w-full mx-4">
            <p className="text-sm text-neutral-900 dark:text-neutral-100 mb-4">
              {t('settings.confirmDiscardChanges')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowCloseConfirm(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => { setShowCloseConfirm(false); onClose(); }}>
                {t('settings.discard')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
