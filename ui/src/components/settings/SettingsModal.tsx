import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import SettingsSidebar from './SettingsSidebar';
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
import { isElectron } from '../../utils/env';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
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
  const has = typeof window.electronAPI?.restartService === 'function';
  console.log('[OhMyAgent] canRestartService:', has, {
    hasElectronAPI: window.electronAPI !== undefined,
    apiKeys: window.electronAPI ? Object.keys(window.electronAPI) : [],
    restartServiceType: window.electronAPI ? typeof window.electronAPI.restartService : 'N/A',
  });
  return has;
}

interface SettingsModalProps {
  onClose: () => void;
}

export const SETTINGS_GROUPS = [
  { id: 'general', labelKey: 'settings.groups.general' },
  { id: 'models', labelKey: 'settings.groups.models' },
  { id: 'agents', labelKey: 'settings.groups.agents' },
  { id: 'channels', labelKey: 'settings.groups.channels' },
  { id: 'tools', labelKey: 'settings.groups.toolsPolicy' },
  { id: 'websearch', labelKey: 'settings.groups.websearch' },
  { id: 'memory', labelKey: 'settings.groups.memory' },
  { id: 'multimodal', labelKey: 'settings.groups.multimodal' },
  { id: 'computer', labelKey: 'settings.groups.computer' },
  { id: 'desktop', labelKey: 'settings.groups.desktop' },
  { id: 'gateway', labelKey: 'settings.groups.gateway' },
] as const;

const COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  general: GeneralSettings,
  models: ModelSettings,
  channels: ChannelsSettings,
  agents: AgentSettings,
  tools: ToolsPolicySettings,
  websearch: WebSearchSettings,
  memory: MemorySettings,
  multimodal: MultimodalSettings,
  computer: ComputerUseSettings,
  desktop: DesktopSettings,
  gateway: GatewaySettings,
};

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [activeGroup, setActiveGroup] = useState<string>('general');
  const [saving, setSaving] = useState(false);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
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
    (g) => (g.id !== 'desktop' && g.id !== 'gateway') || isElectron(),
  );

  // If currently on an Electron-only tab and not in Electron, fall back to general
  if (!isElectron() && (activeGroup === 'desktop' || activeGroup === 'gateway')) {
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

  // Called by each tab to report dirty state changes
  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setDirtyTabs(prev => {
      const next = new Set(prev);
      if (dirty) next.add(tabId); else next.delete(tabId);
      return next;
    });
  }, []);

  const hasGlobalDirty = dirtyTabs.size > 0;

  const handleRestart = useCallback(async () => {
    if (!canRestartService()) return;

    showToast(t('settings.restarting'), 'info', 2000);
    try {
      const result = await window.electronAPI!.restartService();
      if (!result?.ok) {
        showToast(result?.error || t('settings.saveError'), 'error');
      }
      // On success the app exits and relaunches — the page will reload.
    } catch {
      showToast(t('settings.saveError'), 'error');
    }
  }, [showToast, t]);

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
          }
        }
      }
      if (savedCount > 0) {
        if (needsRestart) {
          const canRestart = canRestartService();
          console.log('[OhMyAgent] SettingsModal handleSave: needsRestart=true, canRestartService=', canRestart, {
            savedTabs: [...dirtyTabs].filter(t => RESTART_REQUIRED_TABS.has(t)),
            allDirtyTabs: [...dirtyTabs],
            isElectronResult: isElectron(),
          });
          if (canRestart) {
            // Electron: show toast with restart action button
            showToast(t('settings.restartNeeded'), 'info', 0, {
              label: t('settings.restartNow'),
              onClick: handleRestart,
            });
          } else {
            // WebUI: informational only — user restarts manually
            showToast(t('settings.restartNeeded'), 'info', 6000);
          }
        } else {
          showToast(t('settings.saved'), 'success');
        }
      }
    } catch {
      // Error toast already shown by individual save
    } finally {
      setSaving(false);
    }
  }, [dirtyTabs, showToast, t, handleRestart]);

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

  // Tab switching is always allowed — no confirmation.
  const handleSidebarSelect = useCallback((id: string) => {
    setActiveGroup(id);
  }, []);

  // ── Render helpers ──

  const tabProps = { registerHandle, onDirtyChange: handleDirtyChange };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 max-sm:p-0 sm:p-4 backdrop-blur-sm">
      <div className="relative flex max-sm:flex-col h-[85vh] max-sm:h-full max-sm:max-h-full w-full max-w-[860px] max-sm:max-w-none overflow-hidden rounded-xl max-sm:rounded-none border border-neutral-200 max-sm:border-0 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        {/* Side nav */}
        <div className="flex w-[180px] max-sm:w-full max-sm:h-auto shrink-0 flex-col border-r max-sm:border-r-0 max-sm:border-b border-neutral-200 bg-neutral-50/80 dark:border-neutral-800 dark:bg-neutral-900/50">
          <div className="flex h-12 max-sm:h-9 items-center px-4 max-sm:px-3 border-b max-sm:border-b-0 border-neutral-200 dark:border-neutral-800 shrink-0">
            <h2 className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100 whitespace-nowrap">
              {t('settings.title')}
            </h2>
          </div>
          <SettingsSidebar
            groups={visibleGroups}
            activeGroup={activeGroup}
            onSelect={handleSidebarSelect}
          />
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          <div className="flex h-12 max-sm:h-9 items-center justify-between px-6 max-sm:px-3 border-b border-neutral-200 dark:border-neutral-800">
            <h3 className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300 truncate">
              {t(visibleGroups.find(g => g.id === activeGroup)?.labelKey || '')}
            </h3>
            <div className="flex items-center gap-2">
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
          </div>
          <div className="flex-1 overflow-y-auto p-6 max-sm:p-4">
            {/* Tabs that support save/cancel stay mounted once visited */}
            {mountedTabs.has('general') && (
              <div style={{ display: activeGroup === 'general' ? undefined : 'none' }}>
                <GeneralSettings tabId="general" {...tabProps} />
              </div>
            )}
            {mountedTabs.has('models') && (
              <div style={{ display: activeGroup === 'models' ? undefined : 'none' }}>
                <ModelSettings {...tabProps} />
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
            {mountedTabs.has('desktop') && (
              <div style={{ display: activeGroup === 'desktop' ? undefined : 'none' }}>
                <DesktopSettings />
              </div>
            )}
            {mountedTabs.has('gateway') && (
              <div style={{ display: activeGroup === 'gateway' ? undefined : 'none' }}>
                <GatewaySettings {...tabProps} />
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
