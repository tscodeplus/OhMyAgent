// ---------------------------------------------------------------------------
// MCP settings — install / edit form (§13.3(b))
// ---------------------------------------------------------------------------
//
// Two transports share one form:
//   stdio — command / args / env / cwd
//   http  — url / headers / oauth
// The transport is picked with a segmented control, so `command` and `url` can
// never be submitted together: switching transport clears the other group's
// fields and the payload only ever carries the selected one.
//
// "Test Connection" calls `POST /api/mcp/test`, which connects a throwaway
// client without persisting anything. It is the visible window for the first
// `npx -y` download (§13.3 note) — a failure shows the reason plus the child
// process stderr tail and still lets the user save ("save anyway").
//
// Secrets: `env` / `headers` values come back from the API masked as `••••••`.
// The mask is a protocol value, not data — `src/mcp/masking.ts:isMaskedValue()`
// tells the route to keep the stored secret — so unchanged rows are submitted
// as-is and only an actually edited row carries a new value.

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import type {
  McpExposure,
  McpOAuthConfig,
  McpPreset,
  McpPresetEnvVar,
  McpServerInput,
  McpServerView,
  McpTestResult,
  McpTransport,
} from './McpServerCard';

/** Editable form state. `McpServerInput` has no transport, the draft does. */
export interface McpServerDraft {
  transport: McpTransport;
  name: string;
  enabled: boolean;
  exposure: McpExposure;
  description: string;
  timeoutSec?: number;
  /** stdio */
  command: string;
  args: string[];
  env: Array<{ key: string; value: string }>;
  cwd: string;
  /** http */
  url: string;
  headers: Array<{ key: string; value: string }>;
  oauth?: Partial<McpOAuthConfig>;
  /** Preset metadata: env vars the user still has to provide (§13.3a). */
  requiredEnv?: McpPresetEnvVar[];
}

/** Fresh draft for "add server" / "manual add". */
export function emptyMcpDraft(): McpServerDraft {
  return {
    transport: 'stdio',
    name: '',
    enabled: true,
    exposure: 'deferred',
    description: '',
    command: '',
    args: [],
    env: [],
    cwd: '',
    url: '',
    headers: [],
  };
}

/** Draft pre-filled from a preset — the user only fills the required env (§13.3a). */
export function mcpDraftFromPreset(preset: McpPreset): McpServerDraft {
  return {
    ...emptyMcpDraft(),
    transport: preset.transport,
    // `id` is the slug; `name` is a display title and may not be a valid server name.
    name: preset.id,
    description: preset.description,
    command: preset.command ?? '',
    args: preset.args ?? [],
    url: preset.url ?? '',
    env: preset.env.map((e) => ({ key: e.key, value: '' })),
    requiredEnv: preset.env,
  };
}

/**
 * Draft for editing an installed server.
 *
 * `McpServerView` only carries `envKeys` / `headerKeys` (never values), so the
 * masked key/value maps are read from `GET /api/config` — the same masked view
 * the generic settings tabs use. Callers must have fetched it; a missing entry
 * degrades to an empty editor rather than inventing values.
 */
export function mcpDraftFromConfig(
  server: McpServerView,
  config: Record<string, unknown> | null,
): McpServerDraft {
  const raw = readRawServerConfig(config, server.name);
  const env = recordToRows(raw?.env);
  const headers = recordToRows(raw?.headers);
  const oauth = readOAuth(raw?.oauth);
  return {
    transport: server.transport,
    name: server.name,
    enabled: server.enabled,
    exposure: server.exposure,
    description: server.description ?? '',
    timeoutSec: server.timeoutSec,
    command: server.command ?? '',
    args: server.args ?? [],
    env,
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    headers,
    ...(oauth ? { oauth } : {}),
  };
}

/**
 * The masked per-server entry of `GET /api/config` (`mcp.servers.<name>`).
 *
 * Shared with the detail drawer's "raw config" block: `McpServerView` only
 * exposes `envKeys` / `headerKeys`, so the key/value map has to come from the
 * generic config view. Values there are already masked (§13.7).
 */
export function readRawServerConfig(
  config: Record<string, unknown> | null,
  name: string,
): Record<string, unknown> | undefined {
  const mcp = config?.mcp;
  if (!mcp || typeof mcp !== 'object') return undefined;
  const servers = (mcp as { servers?: unknown }).servers;
  if (!servers || typeof servers !== 'object') return undefined;
  const entry = (servers as Record<string, unknown>)[name];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

function recordToRows(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
    key,
    value: v === null || v === undefined ? '' : String(v),
  }));
}

function readOAuth(value: unknown): Partial<McpOAuthConfig> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  return {
    clientId: text('clientId'),
    clientSecret: text('clientSecret'),
    scope: text('scope'),
    clientName: text('clientName'),
    callbackUrl: text('callbackUrl'),
    authServerMetadataUrl: text('authServerMetadataUrl'),
    callbackPort: typeof o.callbackPort === 'number' ? o.callbackPort : 0,
  };
}

export interface McpServerFormProps {
  /** `null` = create; a view = edit (rename is not allowed, §13.7). */
  editing: McpServerView | null;
  initial: McpServerDraft;
  /** Installed server names, for the duplicate check. */
  existingNames: string[];
  onClose: () => void;
  onSaved: (server: McpServerView) => void;
}

export default function McpServerForm({
  editing,
  initial,
  existingNames,
  onClose,
  onSaved,
}: McpServerFormProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const [transport, setTransport] = useState<McpTransport>(initial.transport);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [exposure, setExposure] = useState<McpExposure>(initial.exposure);
  const [timeoutSec, setTimeoutSec] = useState(
    initial.timeoutSec ? String(initial.timeoutSec) : '',
  );
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState<string[]>(initial.args);
  const [env, setEnv] = useState(initial.env);
  const [cwd, setCwd] = useState(initial.cwd);
  const [url, setUrl] = useState(initial.url);
  const [headers, setHeaders] = useState(initial.headers);
  const [oauth, setOauth] = useState<Partial<McpOAuthConfig>>(initial.oauth ?? {});
  const [showOAuth, setShowOAuth] = useState(Boolean(initial.oauth));
  const [markErrors, setMarkErrors] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<McpTestResult | null>(null);

  // ── Validation (§5.2 rules, mirrored for instant feedback) ──

  const normalizedExisting = useMemo(() => {
    const set = new Set<string>();
    for (const n of existingNames) {
      if (n !== editing?.name) set.add(normalizeServerName(n));
    }
    return set;
  }, [existingNames, editing]);

  const nameError = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return t('settings.mcp.form.errors.nameRequired');
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return t('settings.mcp.form.errors.nameInvalid');
    if (normalizedExisting.has(normalizeServerName(trimmed))) {
      return t('settings.mcp.form.errors.nameTaken');
    }
    return undefined;
  }, [name, normalizedExisting, t]);

  const commandFilled = command.trim().length > 0;
  const urlFilled = url.trim().length > 0;
  const endpointError =
    transport === 'stdio'
      ? commandFilled
        ? undefined
        : t('settings.mcp.form.errors.commandRequired')
      : urlFilled
        ? undefined
        : t('settings.mcp.form.errors.urlRequired');

  // Upstream has no HTTP+SSE transport; the legacy `/sse` endpoint is rejected
  // here instead of silently connecting as streamable HTTP (§5.2, §19 limits).
  const sseError =
    transport === 'http' && urlFilled && /\/sse\/?$/i.test(url.trim())
      ? t('settings.mcp.form.errors.sseUnsupported')
      : undefined;

  const timeoutError =
    timeoutSec.trim() && !/^[1-9]\d*$/.test(timeoutSec.trim())
      ? t('settings.mcp.form.errors.timeoutInvalid')
      : undefined;

  const duplicatedKey = duplicateKey(transport === 'stdio' ? env : headers);
  const duplicateError = duplicatedKey
    ? t('settings.mcp.form.errors.duplicateKey', { key: duplicatedKey })
    : undefined;

  const missingRequiredEnv = (initial.requiredEnv ?? []).filter(
    (e) => e.required && !env.some((row) => row.key === e.key && row.value.trim().length > 0),
  );

  const invalid =
    Boolean(nameError) ||
    Boolean(endpointError) ||
    Boolean(sseError) ||
    Boolean(timeoutError) ||
    Boolean(duplicateError) ||
    missingRequiredEnv.length > 0;

  const show = (error?: string) => (markErrors ? error : undefined);

  // ── Payload ──

  const buildInput = (): McpServerInput => {
    const input: McpServerInput = {
      name: name.trim(),
      enabled: initial.enabled,
      exposure,
      description: description.trim(),
    };
    const timeout = timeoutSec.trim();
    if (timeout) input.timeoutSec = Number(timeout);
    if (transport === 'stdio') {
      input.command = command.trim();
      const cleanedArgs = args.filter((a) => a.length > 0);
      if (cleanedArgs.length > 0) input.args = cleanedArgs;
      const envRecord = rowsToRecord(env);
      if (Object.keys(envRecord).length > 0) input.env = envRecord;
      if (cwd.trim()) input.cwd = cwd.trim();
    } else {
      input.url = url.trim();
      const headerRecord = rowsToRecord(headers);
      if (Object.keys(headerRecord).length > 0) input.headers = headerRecord;
      const oauthPayload = oauthToPayload(oauth);
      if (oauthPayload) input.oauth = oauthPayload;
    }
    return input;
  };

  const handleTest = async () => {
    setMarkErrors(true);
    setTest(null);
    if (invalid) return;
    setTesting(true);
    try {
      // A first `npx -y` download can take a while; the default 10s client
      // timeout is far below `mcp.connect_timeout_sec`.
      const result = await apiRequest<McpTestResult>('/api/mcp/test', {
        method: 'POST',
        body: JSON.stringify(buildInput()),
        timeoutMs: 60_000,
      });
      setTest(result);
    } catch (err) {
      setTest({ ok: false, error: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    setMarkErrors(true);
    if (invalid) return;
    setSaving(true);
    try {
      const body = JSON.stringify(buildInput());
      const result = editing
        ? await apiRequest<{ ok: boolean; server: McpServerView }>(
            `/api/mcp/servers/${encodeURIComponent(editing.name)}`,
            { method: 'PUT', body },
          )
        : await apiRequest<{ ok: boolean; server: McpServerView }>('/api/mcp/servers', {
            method: 'POST',
            body,
          });
      onSaved(result.server);
    } catch (err) {
      showToast(errorText(err) || t('settings.saveError'), 'error', 6000);
    } finally {
      setSaving(false);
    }
  };

  const switchTransport = (next: McpTransport) => {
    if (next === transport) return;
    // Exclusivity is structural: the payload only ever carries the selected
    // transport, so stale values from the other group must not linger.
    if (next === 'stdio') setUrl('');
    else setCommand('');
    setTest(null);
    setTransport(next);
  };

  const submitLabel =
    test && !test.ok
      ? t('settings.mcp.form.saveAnyway')
      : editing
        ? t('settings.mcp.form.update')
        : t('settings.mcp.form.install');

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={editing ? t('settings.mcp.action.edit') : t('settings.mcp.addServer')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={handleTest} loading={testing} disabled={saving}>
            {t('settings.mcp.form.testConnection')}
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TransportSwitch value={transport} onChange={switchTransport} />

        <Input
          label={t('settings.mcp.form.name')}
          required
          // Renaming is not supported by `PUT /api/mcp/servers/:name` (§13.7).
          disabled={Boolean(editing)}
          value={name}
          error={show(nameError)}
          placeholder="my-server"
          onChange={(e) => setName(e.target.value)}
        />

        {transport === 'stdio' ? (
          <>
            <Input
              label={t('settings.mcp.form.command')}
              required
              value={command}
              error={show(endpointError)}
              placeholder="npx"
              className="font-mono"
              onChange={(e) => setCommand(e.target.value)}
            />
            <StringListEditor
              label={t('settings.mcp.form.args')}
              values={args}
              placeholder="-y"
              onChange={setArgs}
              addLabel={t('settings.mcp.form.addRow')}
              removeLabel={t('settings.mcp.form.removeRow')}
            />
            <KeyValueEditor
              label={t('settings.mcp.form.env')}
              rows={env}
              hint={editing ? t('settings.mcp.form.secretMaskedHint') : undefined}
              error={
                show(duplicateError) ??
                show(
                  missingRequiredEnv.length > 0
                    ? t('settings.mcp.form.errors.envRequired', {
                        vars: missingRequiredEnv.join(', '),
                      })
                    : undefined,
                )
              }
              onChange={setEnv}
              addLabel={t('settings.mcp.form.addRow')}
              removeLabel={t('settings.mcp.form.removeRow')}
            />
            <Input
              label={t('settings.mcp.form.cwd')}
              value={cwd}
              placeholder="~/projects/demo"
              onChange={(e) => setCwd(e.target.value)}
            />
          </>
        ) : (
          <>
            <Input
              label={t('settings.mcp.form.url')}
              required
              value={url}
              error={show(sseError ?? endpointError)}
              placeholder="https://example.com/mcp"
              className="font-mono"
              onChange={(e) => {
                setUrl(e.target.value);
                setTest(null);
              }}
            />
            <KeyValueEditor
              label={t('settings.mcp.form.headers')}
              rows={headers}
              hint={editing ? t('settings.mcp.form.secretMaskedHint') : undefined}
              error={show(duplicateError)}
              onChange={setHeaders}
              addLabel={t('settings.mcp.form.addRow')}
              removeLabel={t('settings.mcp.form.removeRow')}
            />
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setShowOAuth((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] font-medium text-neutral-700 dark:text-neutral-300"
              >
                {t('settings.mcp.form.oauth')}
                <span className="text-xs text-neutral-400">{showOAuth ? '−' : '+'}</span>
              </button>
              {showOAuth && (
                <div className="space-y-3 border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {t('settings.mcp.form.oauthHint')}
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Input
                      label="Client ID"
                      value={oauth.clientId ?? ''}
                      onChange={(e) => setOauth({ ...oauth, clientId: e.target.value })}
                    />
                    <Input
                      label="Client Secret"
                      type="password"
                      value={oauth.clientSecret ?? ''}
                      onChange={(e) => setOauth({ ...oauth, clientSecret: e.target.value })}
                    />
                    <Input
                      label="Scope"
                      value={oauth.scope ?? ''}
                      onChange={(e) => setOauth({ ...oauth, scope: e.target.value })}
                    />
                    <Input
                      label="Client Name"
                      value={oauth.clientName ?? ''}
                      onChange={(e) => setOauth({ ...oauth, clientName: e.target.value })}
                    />
                    <Input
                      label="Callback Port"
                      value={oauth.callbackPort ? String(oauth.callbackPort) : ''}
                      onChange={(e) =>
                        setOauth({ ...oauth, callbackPort: Number(e.target.value) || 0 })
                      }
                    />
                    <Input
                      label="Callback URL"
                      value={oauth.callbackUrl ?? ''}
                      onChange={(e) => setOauth({ ...oauth, callbackUrl: e.target.value })}
                    />
                  </div>
                  <Input
                    label="Auth Server Metadata URL"
                    value={oauth.authServerMetadataUrl ?? ''}
                    onChange={(e) => setOauth({ ...oauth, authServerMetadataUrl: e.target.value })}
                  />
                </div>
              )}
            </div>
          </>
        )}

        <Input
          label={t('settings.mcp.form.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Select
              label={t('settings.mcp.form.exposure')}
              value={exposure}
              onChange={(e) => setExposure(e.target.value as McpExposure)}
              // Raw config tokens (never translated): they are what a user
              // copies into `config.yaml`; the hint below explains the value.
              options={[
                { value: 'direct', label: 'direct' },
                { value: 'deferred', label: 'deferred' },
                { value: 'hidden', label: 'hidden' },
              ]}
            />
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t(`settings.mcp.form.exposureHint.${exposure}`)}
            </p>
          </div>
          <Input
            label={t('settings.mcp.form.timeout')}
            value={timeoutSec}
            error={show(timeoutError)}
            placeholder="60"
            inputMode="numeric"
            onChange={(e) => setTimeoutSec(e.target.value)}
          />
        </div>

        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('settings.mcp.form.testHint')}
        </p>

        {test && <TestResultPanel result={test} />}
      </div>
    </Modal>
  );
}

/** Segmented stdio / HTTP picker (labels reuse the transport badge keys). */
function TransportSwitch({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (next: McpTransport) => void;
}) {
  const { t } = useTranslation('common');
  const options: McpTransport[] = ['stdio', 'http'];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
        {t('settings.mcp.form.transport')}
      </span>
      <div className="inline-flex w-fit rounded-lg border border-neutral-300 p-0.5 dark:border-neutral-700">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              value === option
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
            }`}
          >
            {t(`settings.mcp.transport.${option}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function TestResultPanel({ result }: { result: McpTestResult }) {
  const { t } = useTranslation('common');
  if (result.ok) {
    const info = result.serverInfo ?? {};
    const tools = result.tools ?? [];
    return (
      <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
          {t('settings.mcp.form.testSuccess')}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-emerald-800 dark:text-emerald-200">
          {info.name ? (
            <>
              <dt>Server</dt>
              <dd className="font-mono">{info.name}</dd>
            </>
          ) : null}
          {info.version ? (
            <>
              <dt>Version</dt>
              <dd className="font-mono">{info.version}</dd>
            </>
          ) : null}
          {info.protocolVersion ? (
            <>
              <dt>Protocol</dt>
              <dd className="font-mono">{info.protocolVersion}</dd>
            </>
          ) : null}
          <dt>{t('settings.mcp.detail.tools')}</dt>
          <dd>{t('settings.mcp.toolCount', { count: tools.length })}</dd>
        </dl>
        {tools.length > 0 && (
          <ul className="max-h-32 overflow-y-auto font-mono text-[11px] text-emerald-800 dark:text-emerald-200">
            {tools.slice(0, 50).map((tool) => (
              <li key={tool.name} className="truncate" title={tool.description || ''}>
                {tool.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/30">
      <p className="text-xs font-medium text-red-700 dark:text-red-300">
        {t('settings.mcp.form.testFailed')}
      </p>
      {result.error && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-red-700 dark:text-red-300">
          {result.error}
        </pre>
      )}
      {result.stderrTail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-red-600/80 dark:text-red-400/80">
          {result.stderrTail}
        </pre>
      )}
    </div>
  );
}

/** Ordered argument list (`args: string[]`). */
function StringListEditor({
  label,
  values,
  placeholder,
  onChange,
  addLabel,
  removeLabel,
}: {
  label: string;
  values: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
  addLabel: string;
  removeLabel: string;
}) {
  // Row identity is independent of the value so editing does not remount inputs.
  const rowIds = useRowIds(values.length);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </span>
      <div className="space-y-1.5">
        {values.map((value, i) => (
          <div key={rowIds[i]} className="flex items-center gap-2">
            <input
              value={value}
              placeholder={placeholder}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                onChange(next);
              }}
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <RowRemoveButton
              label={removeLabel}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="inline-flex w-fit items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <Plus size={12} />
        {addLabel}
      </button>
    </div>
  );
}

/** Key/value editor for `env` and `headers`. */
function KeyValueEditor({
  label,
  rows,
  hint,
  error,
  onChange,
  addLabel,
  removeLabel,
}: {
  label: string;
  rows: Array<{ key: string; value: string }>;
  hint?: string;
  error?: string;
  onChange: (next: Array<{ key: string; value: string }>) => void;
  addLabel: string;
  removeLabel: string;
}) {
  const rowIds = useRowIds(rows.length);

  const patch = (i: number, patchRow: Partial<{ key: string; value: string }>) => {
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patchRow } : row)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
        {label}
      </span>
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={rowIds[i]} className="flex items-center gap-2">
            <input
              value={row.key}
              placeholder="KEY"
              onChange={(e) => patch(i, { key: e.target.value })}
              className="w-2/5 min-w-0 rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <input
              value={row.value}
              placeholder="value"
              onChange={(e) => patch(i, { value: e.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
            />
            <RowRemoveButton
              label={removeLabel}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="inline-flex w-fit items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <Plus size={12} />
        {addLabel}
      </button>
      {hint && !error && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/** Stable row keys for the dynamic editors: position-independent, no remount. */
function useRowIds(count: number): number[] {
  const idsRef = useRef<number[]>([]);
  const counterRef = useRef(0);
  while (idsRef.current.length < count) idsRef.current.push(counterRef.current++);
  idsRef.current.length = count;
  return idsRef.current;
}

function RowRemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
    >
      <Trash2 size={14} strokeWidth={1.75} />
    </button>
  );
}

// ── helpers ──

/** Server names are compared after `-`/`_` normalisation (§13.3b). */
function normalizeServerName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_');
}

/** First duplicated key, or undefined. Blank keys are ignored (dropped on submit). */
function duplicateKey(rows: Array<{ key: string; value: string }>): string | undefined {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) return key;
    seen.add(normalized);
  }
  return undefined;
}

/** Drop blank keys; keep masked values (the backend keeps the stored secret). */
function rowsToRecord(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.value;
  }
  return out;
}

function oauthToPayload(oauth: Partial<McpOAuthConfig>): Partial<McpOAuthConfig> | undefined {
  const entries = Object.entries(oauth).filter(([, value]) =>
    typeof value === 'number' ? value > 0 : Boolean(value),
  );
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<McpOAuthConfig>) : undefined;
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return '';
}
