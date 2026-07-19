import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Lock, User, Shield } from 'lucide-react';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Modal from '../../ui/Modal';

// ---------------------------------------------------------------------------
// Types (mirroring src/harness/types.ts for UI use)
// ---------------------------------------------------------------------------

type ApprovalAction = 'require_approval' | 'auto_apply' | 'skip';

type ChangeType =
  | 'prompt_text'
  | 'prompt_structure'
  | 'trigger_add'
  | 'trigger_remove'
  | 'tool_allow_add'
  | 'tool_allow_remove'
  | 'tool_desc_edit'
  | 'execution_policy'
  | 'approval_policy'
  | 'numeric_threshold'
  | 'spawn_policy_edit'
  | 'memory_policy_edit';

type RiskLevel = 'none' | 'low' | 'medium';

interface AutoRollbackConfig {
  observationWindow: number;
  satisfactionThreshold: number;
  errorRateMultiplier: number;
}

interface ApprovalRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  skillIds?: string[];
  agentIds?: string[];
  changeTypes?: ChangeType[];
  riskLevels?: RiskLevel[];
  action: ApprovalAction;
  autoRollback?: AutoRollbackConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANGE_TYPE_OPTIONS: { value: ChangeType; label: string }[] = [
  { value: 'prompt_text', label: 'Prompt Text' },
  { value: 'prompt_structure', label: 'Prompt Structure' },
  { value: 'trigger_add', label: 'Add Trigger' },
  { value: 'trigger_remove', label: 'Remove Trigger' },
  { value: 'tool_allow_add', label: 'Allow Tool' },
  { value: 'tool_allow_remove', label: 'Remove Tool' },
  { value: 'tool_desc_edit', label: 'Edit Tool Desc' },
  { value: 'execution_policy', label: 'Execution Policy' },
  { value: 'approval_policy', label: 'Approval Policy' },
  { value: 'numeric_threshold', label: 'Numeric Threshold' },
  { value: 'spawn_policy_edit', label: 'Spawn Policy' },
  { value: 'memory_policy_edit', label: 'Memory Policy' },
];

const RISK_LEVEL_OPTIONS: { value: RiskLevel; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
];

const ACTION_OPTIONS: { value: ApprovalAction; label: string }[] = [
  { value: 'require_approval', label: 'Require Approval' },
  { value: 'auto_apply', label: 'Auto-Apply' },
  { value: 'skip', label: 'Skip' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<ApprovalAction, string> = {
  require_approval: 'Require Approval',
  auto_apply: 'Auto-Apply',
  skip: 'Skip',
};

const ACTION_COLORS: Record<ApprovalAction, string> = {
  require_approval:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  auto_apply:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  skip: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
};

function isSystemRule(id: string): boolean {
  return id.startsWith('default-');
}

function summarizeConditions(rule: ApprovalRule): string {
  const parts: string[] = [];
  if (rule.skillIds?.length) parts.push(`${rule.skillIds.length} skill(s)`);
  if (rule.agentIds?.length) parts.push(`${rule.agentIds.length} agent(s)`);
  if (rule.changeTypes?.length) parts.push(`${rule.changeTypes.length} change type(s)`);
  if (rule.riskLevels?.length) parts.push(`${rule.riskLevels.join(', ')} risk`);
  return parts.length ? parts.join(', ') : 'All changes';
}

function createDefaultRule(): ApprovalRule {
  return {
    id: '',
    name: '',
    priority: 50,
    enabled: true,
    skillIds: [],
    agentIds: [],
    changeTypes: [],
    riskLevels: [],
    action: 'require_approval',
    autoRollback: {
      observationWindow: 5,
      satisfactionThreshold: 0.7,
      errorRateMultiplier: 2.0,
    },
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ApprovalRulesEditorProps {
  rules: any[];
  onChange: (rules: any[]) => void;
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ApprovalRulesEditor({
  rules,
  onChange,
  readOnly = false,
}: ApprovalRulesEditorProps) {
  const { t } = useTranslation('common');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ApprovalRule | null>(null);
  const [form, setForm] = useState<ApprovalRule>(createDefaultRule());
  const [skillInput, setSkillInput] = useState('');
  const [agentInput, setAgentInput] = useState('');

  const isEditing = !!editingRule;

  // --- Modal handlers ---

  function openAddModal() {
    setEditingRule(null);
    setForm(createDefaultRule());
    setSkillInput('');
    setAgentInput('');
    setModalOpen(true);
  }

  function openEditModal(rule: ApprovalRule) {
    setEditingRule(rule);
    setForm({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      enabled: rule.enabled,
      skillIds: [...(rule.skillIds || [])],
      agentIds: [...(rule.agentIds || [])],
      changeTypes: [...(rule.changeTypes || [])],
      riskLevels: [...(rule.riskLevels || [])],
      action: rule.action,
      autoRollback: rule.autoRollback
        ? { ...rule.autoRollback }
        : { observationWindow: 5, satisfactionThreshold: 0.7, errorRateMultiplier: 2.0 },
    });
    setSkillInput('');
    setAgentInput('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingRule(null);
  }

  function handleSave() {
    if (!form.name.trim()) return;

    const newRule: ApprovalRule = {
      ...form,
      id: isEditing ? form.id : `custom-${Date.now()}`,
      name: form.name.trim(),
      skillIds: form.skillIds?.filter(Boolean) || [],
      agentIds: form.agentIds?.filter(Boolean) || [],
      changeTypes: form.changeTypes || [],
      riskLevels: form.riskLevels || [],
      autoRollback: form.action === 'auto_apply' ? form.autoRollback : undefined,
    };

    let updated: ApprovalRule[];
    if (isEditing) {
      updated = rules.map((r) => (r.id === newRule.id ? newRule : r));
    } else {
      updated = [...rules, newRule];
    }
    onChange(updated);
    closeModal();
  }

  function handleDelete(id: string) {
    onChange(rules.filter((r) => r.id !== id));
  }

  function handleToggleEnabled(id: string, enabled: boolean) {
    onChange(rules.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }

  // --- Form helpers ---

  function toggleArrayItem(arr: string[] | undefined, item: string): string[] {
    const current = arr || [];
    return current.includes(item)
      ? current.filter((v) => v !== item)
      : [...current, item];
  }

  function addSkillTag() {
    const val = skillInput.trim();
    if (!val || (form.skillIds || []).includes(val)) return;
    setForm({ ...form, skillIds: [...(form.skillIds || []), val] });
    setSkillInput('');
  }

  function removeSkillTag(idx: number) {
    setForm({
      ...form,
      skillIds: (form.skillIds || []).filter((_, i) => i !== idx),
    });
  }

  function addAgentTag() {
    const val = agentInput.trim();
    if (!val || (form.agentIds || []).includes(val)) return;
    setForm({ ...form, agentIds: [...(form.agentIds || []), val] });
    setAgentInput('');
  }

  function removeAgentTag(idx: number) {
    setForm({
      ...form,
      agentIds: (form.agentIds || []).filter((_, i) => i !== idx),
    });
  }

  // --- Render ---

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Approval Rules
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Define when harness changes require human approval, can be auto-applied, or skipped.
          </p>
        </div>
        {!readOnly && (
          <Button size="sm" onClick={openAddModal}>
            <Plus size={14} /> Add Rule
          </Button>
        )}
      </div>

      {/* Rules Table */}
      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 p-8 text-center">
          <Shield size={32} className="mx-auto mb-2 text-neutral-400" />
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No approval rules configured.
          </p>
          {!readOnly && (
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              Add rules to control how harness proposals are handled.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 dark:bg-neutral-800">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300 w-10"></th>
                <th className="text-left px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300">Priority</th>
                <th className="text-left px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300">Name</th>
                <th className="text-left px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300">Conditions</th>
                <th className="text-left px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300">Action</th>
                <th className="text-center px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300 w-16">On</th>
                <th className="text-right px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300 w-20">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {[...rules]
                .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                .map((rule) => {
                  const isSystem = isSystemRule(rule.id);
                  return (
                    <tr
                      key={rule.id}
                      className={`hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors ${
                        !rule.enabled ? 'opacity-50' : ''
                      }`}
                    >
                      {/* Icon */}
                      <td className="px-4 py-2.5">
                        {isSystem ? (
                          <span title="System rule">
                            <Lock size={14} className="text-neutral-400" />
                          </span>
                        ) : (
                          <span title="User rule">
                            <User size={14} className="text-blue-500" />
                          </span>
                        )}
                      </td>
                      {/* Priority */}
                      <td className="px-4 py-2.5 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                        {rule.priority}
                      </td>
                      {/* Name */}
                      <td className="px-4 py-2.5 font-medium text-neutral-900 dark:text-neutral-100">
                        {rule.name}
                      </td>
                      {/* Conditions */}
                      <td className="px-4 py-2.5 text-xs text-neutral-500 dark:text-neutral-400 max-w-[200px] truncate">
                        {summarizeConditions(rule)}
                      </td>
                      {/* Action badge */}
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            ACTION_COLORS[rule.action as ApprovalAction] ||
                            ACTION_COLORS.require_approval
                          }`}
                        >
                          {ACTION_LABELS[rule.action as ApprovalAction] || rule.action}
                        </span>
                      </td>
                      {/* Enabled toggle */}
                      <td className="px-4 py-2.5 text-center">
                        {!readOnly && !isSystem ? (
                          <Toggle
                            checked={rule.enabled !== false}
                            onChange={(v) => handleToggleEnabled(rule.id, v)}
                          />
                        ) : (
                          <span className="text-xs text-neutral-400">
                            {rule.enabled !== false ? 'On' : 'Off'}
                          </span>
                        )}
                      </td>
                      {/* Actions */}
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!readOnly && (
                            <>
                              <button
                                onClick={() => openEditModal(rule)}
                                className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
                                title="Edit"
                              >
                                <Pencil size={14} />
                              </button>
                              {!isSystem && (
                                <button
                                  onClick={() => handleDelete(rule.id)}
                                  className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-red-500 hover:text-red-600 dark:text-red-400"
                                  title="Delete"
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add / Edit Modal ── */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={isEditing ? 'Edit Approval Rule' : 'Add Approval Rule'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeModal}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!form.name.trim()}
            >
              {isEditing ? 'Save Changes' : 'Add Rule'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* Name & Priority */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Rule Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Low-risk prompt edits"
            />
            <Input
              label="Priority"
              type="number"
              value={String(form.priority)}
              onChange={(e) =>
                setForm({ ...form, priority: parseInt(e.target.value) || 0 })
              }
            />
          </div>

          {/* Enabled */}
          <div className="flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-700 px-4 py-3">
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Rule Enabled
            </span>
            <Toggle
              checked={form.enabled}
              onChange={(v) => setForm({ ...form, enabled: v })}
            />
          </div>

          {/* Skill IDs */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
              Skill IDs
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={skillInput}
                onChange={(e) => setSkillInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSkillTag();
                  }
                }}
                placeholder="Type skill ID and press Enter"
                className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
              />
              <Button size="sm" variant="secondary" onClick={addSkillTag}>
                Add
              </Button>
            </div>
            {(form.skillIds || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {(form.skillIds || []).map((s, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300"
                  >
                    {s}
                    <button
                      type="button"
                      onClick={() => removeSkillTag(i)}
                      className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Agent IDs */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
              Agent IDs
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={agentInput}
                onChange={(e) => setAgentInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addAgentTag();
                  }
                }}
                placeholder="Type agent ID and press Enter"
                className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
              />
              <Button size="sm" variant="secondary" onClick={addAgentTag}>
                Add
              </Button>
            </div>
            {(form.agentIds || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {(form.agentIds || []).map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:text-neutral-300"
                  >
                    {a}
                    <button
                      type="button"
                      onClick={() => removeAgentTag(i)}
                      className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Change Types (checkboxes) */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
              Change Types
            </label>
            <div className="grid grid-cols-3 gap-2">
              {CHANGE_TYPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 cursor-pointer text-sm text-neutral-700 dark:text-neutral-300"
                >
                  <input
                    type="checkbox"
                    checked={(form.changeTypes || []).includes(opt.value)}
                    onChange={() =>
                      setForm({
                        ...form,
                        changeTypes: toggleArrayItem(
                          form.changeTypes,
                          opt.value
                        ) as ChangeType[],
                      })
                    }
                    className="rounded border-neutral-300 text-blue-500 focus:ring-blue-500/30 dark:border-neutral-600"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Risk Levels (checkboxes) */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
              Risk Levels
            </label>
            <div className="flex gap-4">
              {RISK_LEVEL_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 cursor-pointer text-sm text-neutral-700 dark:text-neutral-300"
                >
                  <input
                    type="checkbox"
                    checked={(form.riskLevels || []).includes(opt.value)}
                    onChange={() =>
                      setForm({
                        ...form,
                        riskLevels: toggleArrayItem(
                          form.riskLevels,
                          opt.value
                        ) as RiskLevel[],
                      })
                    }
                    className="rounded border-neutral-300 text-blue-500 focus:ring-blue-500/30 dark:border-neutral-600"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Action (radio) */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
              Action
            </label>
            <div className="flex gap-4">
              {ACTION_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 cursor-pointer text-sm text-neutral-700 dark:text-neutral-300"
                >
                  <input
                    type="radio"
                    name="approval-action"
                    checked={form.action === opt.value}
                    onChange={() => setForm({ ...form, action: opt.value })}
                    className="border-neutral-300 text-blue-500 focus:ring-blue-500/30 dark:border-neutral-600"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Auto-Rollback (only for auto_apply) */}
          {form.action === 'auto_apply' && (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-4 space-y-3">
              <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wider">
                Auto-Rollback Settings
              </h4>
              <div className="grid grid-cols-3 gap-4">
                <Input
                  label="Observation Window"
                  type="number"
                  value={String(form.autoRollback?.observationWindow ?? 5)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      autoRollback: {
                        ...(form.autoRollback || {
                          satisfactionThreshold: 0.7,
                          errorRateMultiplier: 2.0,
                        }),
                        observationWindow: parseInt(e.target.value) || 5,
                      },
                    })
                  }
                />
                <Input
                  label="Satisfaction Threshold"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={String(form.autoRollback?.satisfactionThreshold ?? 0.7)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      autoRollback: {
                        ...(form.autoRollback || {
                          observationWindow: 5,
                          errorRateMultiplier: 2.0,
                        }),
                        satisfactionThreshold: parseFloat(e.target.value) || 0.7,
                      },
                    })
                  }
                />
                <Input
                  label="Error Rate Multiplier"
                  type="number"
                  step="0.1"
                  min="1"
                  value={String(form.autoRollback?.errorRateMultiplier ?? 2.0)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      autoRollback: {
                        ...(form.autoRollback || {
                          observationWindow: 5,
                          satisfactionThreshold: 0.7,
                        }),
                        errorRateMultiplier: parseFloat(e.target.value) || 2.0,
                      },
                    })
                  }
                />
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
