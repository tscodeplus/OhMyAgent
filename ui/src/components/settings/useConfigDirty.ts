import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import {
  missingRequiredFields,
  type MissingRequiredField,
  type RequiredFieldRule,
} from './requiredFields';

export interface SettingsTabHandle {
  save: (opts?: { silent?: boolean }) => Promise<void>;
  cancel: () => void;
  isDirty: () => boolean;
  /**
   * Optional: evaluate the tab's required-field rules. With { mark: true } the
   * missing fields are also flagged red in the tab's inputs. Returns one entry
   * per missing field (label already localized). The settings modal uses this
   * to block save / warn on tab switch (staging).
   */
  validateRequired?: (opts?: { mark?: boolean }) => MissingRequiredField[];
  /** Optional: returns true when the current dirty changes require a service restart.
   *  Only override when per-item granularity is needed; otherwise the parent
   *  falls back to RESTART_REQUIRED_TABS for the whole tab. */
  needsRestart?: () => boolean;
}

export interface UseConfigDirtyResult {
  config: Record<string, unknown> | null;
  loading: boolean;
  dirtyCount: number;
  /** Paths of currently dirty fields (useful for sub-tab dirty badges). */
  dirtyPaths: string[];
  /** Error string for a required field currently flagged missing, else undefined. */
  requiredError: (path: string) => string | undefined;
  /** Clear the red flags set by validateRequired({ mark: true }). */
  clearRequiredMarks: () => void;
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
  /**
   * Required-field rules for this tab; enables validateRequired on the handle.
   * May be a getter — evaluated lazily at validation time, so it can depend on
   * values derived from this hook (e.g. the selected provider list).
   */
  requiredRules?: RequiredFieldRule[] | (() => RequiredFieldRule[]),
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

  const fetchConfig = useCallback(
    async (showLoading = true) => {
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
    },
    [showToast, t],
  );

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Report dirty state changes to parent
  useEffect(() => {
    onDirtyChange?.(tabId, dirtyCount > 0);
  }, [tabId, dirtyCount, onDirtyChange]);

  const getField = useCallback(
    <T>(path: string, fallback: T): T => {
      if (path in dirtyFields) return dirtyFields[path] as T;
      return fallback;
    },
    [dirtyFields],
  );

  const setField = useCallback((path: string, value: unknown) => {
    setDirtyFields((prev) => ({ ...prev, [path]: value }));
  }, []);

  const save = useCallback(
    async (opts?: { silent?: boolean }) => {
      const current = dirtyFieldsRef.current;
      if (Object.keys(current).length === 0) return;
      try {
        // Numeric paths: convert string values to numbers
        const numericPaths = new Set([
          'rateLimit.webhookMaxRequests',
          'rateLimit.webhookWindowMs',
          'embedding.dimension',
          'tools.defaultTimeoutMs',
          'tools.maxOutputLength',
          'tools.shellApprovalTimeoutSec',
          'policy.approval.timeoutSec',
          'orchestrator.maxChildAgents',
          'smart_agent_team.max_children',
          'memory.recallTopK',
          'memory.recallMinScore',
          'memory.maxCaptureChars',
          'memory.summarizeInterval',
          'memory.decayHalfLife',
          'memory.historyLoadCount',
          'memory.historyMaxTokens',
          'memory.cacheMaxEntries',
          'memory.queryTimeoutMs',
          'memory.retentionDays',
          'memory.failureThreshold',
          'memory.cooldownSec',
          'memory.maxRefs',
          'memory.preserveMsgs',
          'memory.persona.distillThreshold',
          'memory.persona.minDistillIntervalHours',
          'memory.mermaidCanvas.maxNodesInContext',
          'memory.sceneClustering.windowDays',
          'memory.sceneClustering.minMemories',
          'memory.maintenance.intervalMs',
          'memory.dreamCycle.hour',
          'memory.dreamCycle.minute',
          'memory.dreamCycle.windowGraceMinutes',
          'memory.dreamCycle.phaseTimeoutMs',
          'memory.dreamCycle.synthesizeBatchSize',
          'memory.autoCompress.reserveTokens',
          'memory.autoCompress.keepRecentTokens',
          'memory.expansion.minQueryLength',
          'memory.expansion.minScoreTrigger',
          'memory.expansion.maxVariants',
          'webSearch.searchTimeoutMs',
          'webSearch.maxResults',
          'multimodal.image.bridge.timeoutMs',
          'multimodal.image.bridge.maxNoteChars',
          'multimodal.imageGeneration.maxPromptChars',
          'multimodal.videoGeneration.maxPromptChars',
          'multimodal.stt.maxDurationSec',
          'computerUse.ssh.port',
          'feishu.webhookMaxRequests',
          'feishu.webhookWindowMs', // legacy rate limit
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
    },
    [showToast, t, fetchConfig],
  );

  const cancel = useCallback(() => {
    setDirtyFields({});
  }, []);

  // ── Required-field validation (enabled-gating) ──
  // Marks are the set of paths currently flagged red; validateRequired()
  // recomputes them from the rules and the dirty-first resolver below.
  const [requiredMarks, setRequiredMarks] = useState<Set<string>>(new Set());
  const rulesRef = useRef<RequiredFieldRule[] | (() => RequiredFieldRule[])>(requiredRules ?? []);
  rulesRef.current = requiredRules ?? [];
  const configRef = useRef(config);
  configRef.current = config;

  const getResolved = useCallback((path: string, fallback: unknown = ''): unknown => {
    const dirty = dirtyFieldsRef.current;
    if (path in dirty) return dirty[path];
    // Saved config lookup: walk 'a.b.c' segments
    let cur: unknown = configRef.current;
    for (const seg of path.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur === undefined ? fallback : cur;
  }, []);

  const validateRequiredRef = useRef<(opts?: { mark?: boolean }) => MissingRequiredField[]>(
    () => [],
  );
  validateRequiredRef.current = (opts?: { mark?: boolean }) => {
    const resolved = rulesRef.current;
    const rules = typeof resolved === 'function' ? resolved() : resolved;
    if (rules.length === 0) return [];
    const missing = missingRequiredFields(rules, getResolved);
    setRequiredMarks(opts?.mark ? new Set(missing.map((m) => m.path)) : new Set());
    return missing.map((m) => ({ path: m.path, label: t(m.label) }));
  };

  const requiredError = useCallback(
    (path: string) => (requiredMarks.has(path) ? t('settings.validation.required') : undefined),
    [requiredMarks, t],
  );

  const clearRequiredMarks = useCallback(() => setRequiredMarks(new Set()), []);

  // Register/unregister this tab's handle with the parent modal
  const saveRef = useRef(save);
  saveRef.current = save;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const needsRestart = restartPrefixesRef.current
      ? () =>
          restartPrefixesRef.current!.some((prefix) =>
            Object.keys(dirtyFieldsRef.current).some((k) => k.startsWith(prefix)),
          )
      : undefined;
    const handle: SettingsTabHandle = {
      save: (opts) => saveRef.current(opts),
      cancel: () => cancelRef.current(),
      isDirty: () => Object.keys(dirtyFieldsRef.current).length > 0,
      needsRestart,
      validateRequired: (opts) => validateRequiredRef.current(opts),
    };
    registerHandle?.(tabId, handle);
    return () => registerHandle?.(tabId, null);
  }, [tabId]); // Only re-register on mount/unmount or tabId change

  return {
    config,
    loading,
    dirtyCount,
    dirtyPaths: Object.keys(dirtyFields),
    fetchConfig,
    getField,
    setField,
    save,
    cancel,
    requiredError,
    clearRequiredMarks,
  };
}
