import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';

export interface SettingsTabHandle {
  save: (opts?: { silent?: boolean }) => Promise<void>;
  cancel: () => void;
  isDirty: () => boolean;
  /** Optional: returns true when the current dirty changes require a service restart.
   *  Only override when per-item granularity is needed; otherwise the parent
   *  falls back to RESTART_REQUIRED_TABS for the whole tab. */
  needsRestart?: () => boolean;
}

export interface UseConfigDirtyResult {
  config: Record<string, unknown> | null;
  loading: boolean;
  dirtyCount: number;
  fetchConfig: (showLoading?: boolean) => Promise<void>;
  getField: <T>(path: string, fallback: T) => T;
  setField: (path: string, value: unknown) => void;
  save: (opts?: { silent?: boolean }) => Promise<void>;
  cancel: () => void;
}

export function useConfigDirty(
  tabId: string,
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void,
  onDirtyChange?: (tabId: string, dirty: boolean) => void,
  restartFieldPrefixes?: string[],
): UseConfigDirtyResult {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirtyFields, setDirtyFields] = useState<Record<string, unknown>>({});

  const dirtyCount = Object.keys(dirtyFields).length;
  const dirtyFieldsRef = useRef(dirtyFields);
  dirtyFieldsRef.current = dirtyFields;

  const restartPrefixesRef = useRef(restartFieldPrefixes);
  restartPrefixesRef.current = restartFieldPrefixes;

  const fetchConfig = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const d = await apiRequest<Record<string, unknown>>('/api/config');
      setConfig(d);
      setDirtyFields({});
    } catch {
      if (showLoading) showToast(t('settings.loadError'), 'error');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // Report dirty state changes to parent
  useEffect(() => {
    onDirtyChange?.(tabId, dirtyCount > 0);
  }, [tabId, dirtyCount, onDirtyChange]);

  const getField = useCallback(<T,>(path: string, fallback: T): T => {
    if (path in dirtyFields) return dirtyFields[path] as T;
    return fallback;
  }, [dirtyFields]);

  const setField = useCallback((path: string, value: unknown) => {
    setDirtyFields(prev => ({ ...prev, [path]: value }));
  }, []);

  const save = useCallback(async (opts?: { silent?: boolean }) => {
    const current = dirtyFieldsRef.current;
    if (Object.keys(current).length === 0) return;
    try {
      // Numeric paths: convert string values to numbers
      const numericPaths = new Set([
        'rateLimit.webhookMaxRequests', 'rateLimit.webhookWindowMs',
        'embedding.dimension',
        'tools.defaultTimeoutMs', 'tools.maxOutputLength',
        'tools.shellApprovalTimeoutSec',
        'policy.approval.timeoutSec',
        'orchestrator.maxChildAgents', 'smart_agent_team.max_children',
        'memory.recallTopK', 'memory.recallMinScore', 'memory.maxCaptureChars',
        'memory.summarizeInterval', 'memory.decayHalfLife',
        'memory.historyLoadCount',
        'memory.historyMaxTokens',
        'memory.cacheMaxEntries', 'memory.queryTimeoutMs',
        'memory.retentionDays', 'memory.failureThreshold', 'memory.cooldownSec',
        'memory.maxRefs', 'memory.preserveMsgs',
        'memory.persona.distillThreshold', 'memory.persona.minDistillIntervalHours',
        'memory.mermaidCanvas.maxNodesInContext',
        'memory.sceneClustering.windowDays', 'memory.sceneClustering.minMemories',
        'memory.maintenance.intervalMs',
        'memory.dreamCycle.hour', 'memory.dreamCycle.minute',
        'memory.dreamCycle.windowGraceMinutes', 'memory.dreamCycle.phaseTimeoutMs',
        'memory.dreamCycle.synthesizeBatchSize',
        'memory.autoCompress.reserveTokens', 'memory.autoCompress.keepRecentTokens',
        'memory.expansion.minQueryLength', 'memory.expansion.minScoreTrigger',
        'memory.expansion.maxVariants',
        'webSearch.searchTimeoutMs', 'webSearch.maxResults',
        'multimodal.image.bridge.timeoutMs', 'multimodal.image.bridge.maxNoteChars',
        'multimodal.imageGeneration.maxPromptChars', 'multimodal.videoGeneration.maxPromptChars', 'multimodal.stt.maxDurationSec',
        'computerUse.ssh.port',
        'feishu.webhookMaxRequests', 'feishu.webhookWindowMs', // legacy rate limit
        // Harness settings
        'harness.trigger.minIdenticalRetries',
        'harness.trigger.minExplorationSteps',
        'harness.trigger.minConsecutiveErrors',
        'harness.rateLimit.cooldownMinutes',
        'harness.rateLimit.maxPerDay',
        'harness.rateLimit.maxPerHour',
      ]);
      const payload: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(current)) {
        payload[path] = numericPaths.has(path) ? Number(value) : value;
      }
      await apiRequest('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
      if (!opts?.silent) {
        showToast(t('settings.saved'), 'success');
      }
      await fetchConfig(false);
    } catch {
      showToast(t('settings.saveError'), 'error');
      throw new Error('Save failed');
    }
  }, [showToast, t, fetchConfig]);

  const cancel = useCallback(() => {
    setDirtyFields({});
  }, []);

  // Register/unregister this tab's handle with the parent modal
  const saveRef = useRef(save);
  saveRef.current = save;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const needsRestart = restartPrefixesRef.current
      ? () => restartPrefixesRef.current!.some(prefix =>
          Object.keys(dirtyFieldsRef.current).some(k => k.startsWith(prefix)))
      : undefined;
    const handle: SettingsTabHandle = {
      save: (opts) => saveRef.current(opts),
      cancel: () => cancelRef.current(),
      isDirty: () => Object.keys(dirtyFieldsRef.current).length > 0,
      needsRestart,
    };
    registerHandle?.(tabId, handle);
    return () => registerHandle?.(tabId, null);
  }, [tabId]); // Only re-register on mount/unmount or tabId change

  return { config, loading, dirtyCount, fetchConfig, getField, setField, save, cancel };
}
