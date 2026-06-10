/**
 * ApprovalGate — evaluates shell commands and tool calls against
 * stored approval policies and records user decisions.
 */

import { i18n } from '../i18n/index.js';
import type {
  ApprovalGate as IApprovalGate,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalDecisionType,
  ApprovalPolicy,
  PolicyEffect,
  ShellApprovalMode,
  ExecMode,
} from '../app/types.js';
import type { ApprovalPolicyRepository } from '../memory/repositories/approval-policy-repository.js';
import {
  matchesPattern,
  ADB_TEMPLATES,
  splitCommandSegments,
  normalizeCommand,
  checkHardlineBlocklist,
  classifyCommand,
  detectDangerousPatterns,
  checkFilePathsOutsideRoots,
  type NormalizedShellCommand,
} from './shell-command-policy.js';
import { generateId } from '../shared/ids.js';

/**
 * Legacy approval gate — SQLite-backed implementation of ApprovalGate.
 *
 * v4: This class is now accessed exclusively through PolicyCenter adapters
 * (ApprovalGateAdapter and ShellExecutionPolicy). Direct external usage
 * outside these adapters is deprecated.
 */

// ─── Specificity ordering (lower = higher priority) ───

const SPECIFICITY_ORDER: Record<string, number> = {
  exact: 0,
  prefix: 1,
  program: 2,
  regex: 3,
};

const SCOPE_ORDER: Record<string, number> = {
  session: 0,
  skill: 1,
  agent: 2,
  global: 3,
};

// ─── Decision → effect mapping (for always policies) ───

const DECISION_EFFECT_MAP: Record<string, PolicyEffect> = {
  approve_always: 'allow',
  reject_always: 'deny',
};

const SAFE_CHAIN_HELPERS = new Set([
  'sleep',
  'mkdir',
]);

interface SQLiteApprovalGateOptions {
  shellApprovalMode?: ShellApprovalMode;
  shellApprovalWhitelist?: string[];
  execMode?: ExecMode;
  shellAllowlist?: string[];
  /** Allowed file read roots (from FILE_READ_ALLOWED_ROOTS). Used to detect
   *  shell commands that touch files outside the permitted boundary. */
  fileReadAllowedRoots?: string[];
}

// ─── Class ───

export class SQLiteApprovalGate implements IApprovalGate {
  private execMode: ExecMode;
  private whitelistPrograms: Set<string>;
  private allowedRoots: string[];
  private readonly sessionPolicies = new Map<string, Set<string>>();
  /** Reason set by the last evaluation when it returns requires_approval. */
  lastRejectReason?: string;

  constructor(
    private readonly policyRepository: ApprovalPolicyRepository,
    options: SQLiteApprovalGateOptions = {},
  ) {
    // Prefer new execMode, fall back to old shellApprovalMode mapping
    if (options.execMode) {
      this.execMode = options.execMode;
    } else {
      const oldMode = options.shellApprovalMode ?? 'balanced';
      this.execMode = oldMode === 'strict' ? 'safe'
        : oldMode === 'relaxed' ? 'trusted'
        : 'balanced';
    }
    // Prefer new allowlist, fall back to old whitelist
    const rawAllowlist = options.shellAllowlist ?? options.shellApprovalWhitelist ?? [];
    this.whitelistPrograms = new Set(
      rawAllowlist.map(program => program.trim().toLowerCase()).filter(Boolean),
    );
    // File read allowed roots (for path-aware shell approval)
    this.allowedRoots = options.fileReadAllowedRoots ?? [];
  }

  updateConfig(options: SQLiteApprovalGateOptions = {}): void {
    if (options.execMode) {
      this.execMode = options.execMode;
    } else if (options.shellApprovalMode) {
      this.execMode = options.shellApprovalMode === 'strict' ? 'safe'
        : options.shellApprovalMode === 'relaxed' ? 'trusted'
        : 'balanced';
    }

    if (options.shellAllowlist || options.shellApprovalWhitelist) {
      const rawAllowlist = options.shellAllowlist ?? options.shellApprovalWhitelist ?? [];
      this.whitelistPrograms = new Set(
        rawAllowlist.map(program => program.trim().toLowerCase()).filter(Boolean),
      );
    }

    if (options.fileReadAllowedRoots) {
      this.allowedRoots = options.fileReadAllowedRoots;
    }
  }

  /**
   * Evaluate an approval request against stored policies.
   *
   * Algorithm:
   * 1. Fetch all policies for the target kind (shell / tool).
   * 2. Filter by scope compatibility.
   * 3. Filter by pattern match on the command.
   * 4. Sort by specificity (exact > prefix > program > regex).
   * 5. Apply deny-first ordering: deny > allow > require_approval.
   * 6. Default: require_approval.
   */
  async evaluate(request: ApprovalRequest): Promise<ApprovalDecision> {
    // Clear reject reason from previous evaluation
    this.lastRejectReason = undefined;

    // Step 1: Hardline blocklist check (shell only, always applies)
    if (request.kind === 'shell' && request.command) {
      const hardline = checkHardlineBlocklist(request.command);
      if (hardline.blocked) {
        return 'rejected';
      }

      // Step 1.5: Session-level approvals (in-memory, per-session)
      if (request.sessionKey) {
        const sessionKey = request.sessionKey;
        const policyKey = this.makePolicyKey(request.command);
        const sessionApprovals = this.sessionPolicies.get(sessionKey);
        if (sessionApprovals?.has(policyKey)) {
          return 'approved';
        }
      }
    }

    const targetKind = request.kind; // 'shell' | 'tool'
    const policies = this.policyRepository.findByTargetKind(targetKind);

    // Filter by scope and pattern match
    const matched = policies.filter((p) => {
      if (!this.scopeMatches(p, request)) return false;
      return this.policyMatchesCommand(p, request);
    });

    if (request.kind === 'shell' && request.command) {
      const explicitMatches = matched.filter((policy) => policy.source !== 'whitelist');
      if (explicitMatches.length > 0) {
        return this.resolveDecision(explicitMatches);
      }
      return this.evaluateShellExecutionPolicy(request.command);
    }

    if (matched.length === 0) {
      return 'requires_approval';
    }

    return this.resolveDecision(matched);
  }

  /**
   * Record a user decision for a pending approval request.
   *
   * If the decision type is `_always` (approve_always / reject_always),
   * a new persistent policy is created so future matching commands
   * are auto-approved or auto-denied.
   *
   * @param requestId — unique ID of the approval request
   * @param decision — the full decision type from the card button
   * @param command — the actual shell command being approved/denied
   */
  async recordDecision(
    requestId: string,
    decision: ApprovalDecisionType,
    command?: string,
    sessionKey?: string,
    targetKind: 'shell' | 'tool' = 'shell',
  ): Promise<void> {
    // Session-level approval: store in-memory for this session only
    if (targetKind === 'shell' && decision === 'approve_session' && command && sessionKey) {
      const normalized = normalizeCommand(command);
      const policyKey = this.makePolicyKey(normalized);
      if (!this.sessionPolicies.has(sessionKey)) {
        this.sessionPolicies.set(sessionKey, new Set());
      }
      this.sessionPolicies.get(sessionKey)!.add(policyKey);
      return;
    }

    const effect = DECISION_EFFECT_MAP[decision];
    if (!effect) return; // once-decisions don't create policies

    const normalized = command ? command.trim().replace(/\s+/g, ' ') : '*';
    const id = `pol-${generateId()}`;
    this.policyRepository.create({
      id,
      scope: 'global',
      scope_key: '',
      target_kind: targetKind,
      pattern_type: 'exact',
      pattern: normalized,
      effect,
      source: 'user_decision',
      note: `Created from decision ${decision} for command: ${normalized}`,
    });
  }

  /** Create a policy key from a command for session-level matching. */
  private makePolicyKey(command: { program: string; args: string[] }): string {
    const program = command.program.toLowerCase();
    const subcommand = command.args[0]?.toLowerCase() ?? '';
    return subcommand ? `${program}:${subcommand}` : program;
  }

  /**
   * Create policies from a whitelist of program names.
   * Each entry becomes a program-type allow policy.
   */
  createWhitelistPolicies(commands: string[]): void {
    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (!trimmed) continue;
      const id = `allow-${trimmed.replace(/[^a-zA-Z0-9]/g, '-')}`;
      const existing = this.policyRepository.findById(id);
      if (!existing) {
        this.policyRepository.create({
          id,
          scope: 'global',
          scope_key: '',
          target_kind: 'shell',
          pattern_type: 'program',
          pattern: trimmed,
          effect: 'allow',
          source: 'whitelist',
          note: `Auto-allow ${trimmed} program`,
        });
        continue;
      }

      if (existing.source === 'whitelist') {
        this.policyRepository.update(id, {
          pattern_type: 'program',
          pattern: trimmed,
          effect: 'allow',
          note: `Auto-allow ${trimmed} program`,
        });
      }
    }
  }

  /**
   * Create a new approval policy directly (non-persistent session-level
   * policies from skill approval overrides are stored with scope='skill').
   */
  createPolicy(input: {
    id: string;
    scope: string;
    scopeKey: string;
    targetKind: string;
    patternType: ApprovalPolicy['patternType'];
    pattern: string;
    effect: PolicyEffect;
  }): void {
    this.policyRepository.create({
      id: input.id,
      scope: input.scope,
      scope_key: input.scopeKey,
      target_kind: input.targetKind,
      pattern_type: input.patternType,
      pattern: input.pattern,
      effect: input.effect,
      source: 'skill',
      note: `Skill approval override: ${input.scope}/${input.pattern}`,
    });
  }

  /**
   * Get the first policy matching scope + target.
   */
  async getPolicy(
    scope: string,
    target: string,
  ): Promise<ApprovalPolicy | null> {
    const policies = this.policyRepository.findByTargetKind(target);
    const match = policies.find((p) => p.scope === scope);
    if (!match) return null;
    return {
      id: match.id,
      scope: match.scope,
      scopeKey: match.scope_key,
      targetKind: match.target_kind,
      patternType: match.pattern_type as ApprovalPolicy['patternType'],
      pattern: match.pattern,
      effect: match.effect as PolicyEffect,
    };
  }

  // ─── Private helpers ───

  /**
   * Check whether a policy's scope applies to the given request.
   *
   * Scope hierarchy: global > agent > skill > session.
   * A global policy applies to all requests.
   */
  private scopeMatches(
    policy: { scope: string; scope_key?: string },
    request: ApprovalRequest,
  ): boolean {
    if (policy.scope === 'global') {
      return true;
    }

    if (policy.scope !== request.scope) {
      return false;
    }

    const policyScopeKey = policy.scope_key ?? '';
    const requestScopeKey = request.scopeKey ?? '';

    if (policyScopeKey === '' || policyScopeKey === '*') {
      return true;
    }

    if (policy.scope === 'session') {
      return policyScopeKey === requestScopeKey || policyScopeKey === request.sessionKey;
    }

    return policyScopeKey === requestScopeKey;
  }

  /**
   * Check whether a policy's pattern matches the command in the request.
   */
  private policyMatchesCommand(
    policy: { target_kind: string; pattern_type: string; pattern: string },
    request: ApprovalRequest,
  ): boolean {
    if (policy.target_kind === 'shell') {
      if (!request.command) return false;
      return matchesPattern(policy.pattern_type, policy.pattern, request.command);
    }
    // For tool kind, match on tool name via exact pattern
    if (policy.target_kind === 'tool') {
      if (!request.toolName) return false;
      if (policy.pattern_type === 'exact') {
        return policy.pattern === request.toolName;
      }
      if (policy.pattern_type === 'regex') {
        return matchesPattern('regex', policy.pattern, {
          raw: request.toolName,
          normalized: request.toolName,
          program: request.toolName,
          args: [],
          containsSecrets: false,
        });
      }
      return false;
    }
    return false;
  }

  /**
   * Resolve the final decision from a list of matched policies.
   *
   * Sort by specificity (most specific first).
   * Apply deny-first logic: deny > allow > require_approval.
   */
  private resolveDecision(
    policies: Array<{ scope: string; pattern_type: string; pattern: string; effect: string }>,
  ): ApprovalDecision {
    // Sort by specificity:
    //   1. Pattern type (exact > prefix > program > regex)
    //   2. Pattern length within same type (longer = more specific)
    //   3. Deny-first within same length (deny > allow > require_approval)
    const EFFECT_RANK: Record<string, number> = {
      deny: 0,
      allow: 1,
      require_approval: 2,
    };

    const sorted = [...policies].sort((a, b) => {
      const scopeA = SCOPE_ORDER[a.scope] ?? 99;
      const scopeB = SCOPE_ORDER[b.scope] ?? 99;
      if (scopeA !== scopeB) return scopeA - scopeB;

      const typeA = SPECIFICITY_ORDER[a.pattern_type] ?? 99;
      const typeB = SPECIFICITY_ORDER[b.pattern_type] ?? 99;
      if (typeA !== typeB) return typeA - typeB;

      // Within same type, longer pattern = more specific
      const lenDiff = b.pattern.length - a.pattern.length;
      if (lenDiff !== 0) return lenDiff;

      // Tiebreak: deny-first
      return (EFFECT_RANK[a.effect] ?? 99) - (EFFECT_RANK[b.effect] ?? 99);
    });

    return this.effectToDecision(sorted[0]?.effect);
  }

  private effectToDecision(effect: string | undefined): ApprovalDecision {
    switch (effect) {
      case 'deny':
        return 'rejected';
      case 'allow':
        return 'approved';
      case 'require_approval':
        return 'requires_approval';
      default:
        return 'requires_approval';
    }
  }

  private evaluateShellExecutionPolicy(command: NormalizedShellCommand): ApprovalDecision {
    const segments = splitCommandSegments(command.raw);
    if (segments.length === 0) {
      return this.execMode === 'trusted' ? 'approved' : 'requires_approval';
    }

    for (const segment of segments) {
      if (!segment.program) continue;

      const program = segment.program.toLowerCase();
      if (SAFE_CHAIN_HELPERS.has(program)) continue;

      // ---- Path-boundary check (ALL modes, including trusted) ----
      // Classification is needed to know whether this command operates on files.
      // Path check only applies to safe/warn commands that touch files.
      if (this.execMode === 'trusted') {
        const classification = classifyCommand(segment, this.whitelistPrograms);
        if (classification.level === 'safe' || classification.level === 'warn') {
          const outsidePaths = checkFilePathsOutsideRoots(segment, this.allowedRoots);
          if (outsidePaths.length > 0) {
            this.lastRejectReason = i18n.t('tools-builtins:approval.pathOutsideAllowed', { paths: outsidePaths.join(', ') });
            return 'requires_approval';
          }
        }
        continue; // trusted: skip all other checks (hardline already handled)
      }

      // ---- Below: safe & balanced modes only ----

      // Always check dangerous patterns for safe/balanced
      const dangerous = detectDangerousPatterns(segment);
      if (dangerous) return 'requires_approval';

      // adb: requires whitelist membership + passes risk assessment
      if (program === 'adb') {
        if (!this.whitelistPrograms.has('adb')) {
          return 'requires_approval';
        }
        const risk = this.assessAdbRisk(segment);
        if (risk === 'high') return 'requires_approval';
        if (risk === 'medium' && this.execMode === 'safe') return 'requires_approval';
        if (risk === 'unknown') return 'requires_approval'; // safe + balanced both deny unknown
        continue;
      }

      // For non-adb: classify against SAFE_SUBSETS + user allowlist
      const classification = classifyCommand(segment, this.whitelistPrograms);

      // Path-boundary check: even safe/warn commands require approval if they
      // touch files outside the configured allowed roots.
      if (classification.level === 'safe' || classification.level === 'warn') {
        const outsidePaths = checkFilePathsOutsideRoots(segment, this.allowedRoots);
        if (outsidePaths.length > 0) {
          this.lastRejectReason = i18n.t('tools-builtins:approval.pathOutsideAllowed', { paths: outsidePaths.join(', ') });
          return 'requires_approval';
        }
      }

      if (classification.level === 'safe') continue;
      if (classification.level === 'warn') {
        if (this.execMode === 'safe') return 'requires_approval';
        continue;
      }
      if (classification.level === 'denied') {
        return 'requires_approval';
      }
      // unknown: require approval
      return 'requires_approval';
    }

    return 'approved';
  }

  private assessAdbRisk(command: NormalizedShellCommand): 'low' | 'medium' | 'high' | 'unknown' {
    const canonical = this.canonicalizeAdbCommand(command);
    for (const template of ADB_TEMPLATES) {
      if (matchesPattern(template.patternType, template.pattern, canonical)) {
        return template.risk;
      }
    }
    return 'unknown';
  }

  private canonicalizeAdbCommand(command: NormalizedShellCommand): NormalizedShellCommand {
    const args = [...command.args];
    const canonicalArgs: string[] = [];
    const optionsWithValue = new Set(['-s', '-t', '-H', '-P', '-L']);
    const standaloneOptions = new Set(['-d', '-e', '-a']);

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (optionsWithValue.has(arg)) {
        i++;
        continue;
      }
      if (standaloneOptions.has(arg)) {
        continue;
      }
      canonicalArgs.push(arg);
    }

    const normalized = ['adb', ...canonicalArgs].join(' ').trim();
    return {
      raw: normalized,
      normalized,
      program: 'adb',
      args: canonicalArgs,
      containsSecrets: command.containsSecrets,
    };
  }
}
