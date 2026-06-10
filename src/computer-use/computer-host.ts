// src/computer-use/computer-host.ts
//
// Central orchestrator for Computer Use.
// Validates runtime conditions, resolves providers, manages lease lifecycle,
// dispatches actions, and validates snapshots before each action.

import type { Logger } from 'pino';
import type {
  Ctx,
  AppInfo,
  Lease,
  Target,
  AppState,
  Action,
  ActionResult,
  ProviderStatus,
  ActionType,
  ComputerUseCapabilities,
} from './types.js';
import type { ComputerUseProvider } from './provider-contract.js';
import {
  ComputerProviderRegistry,
  resolveComputerProviderId,
} from './provider-registry.js';
import { ComputerLeaseRegistry } from './lease-registry.js';
import { computerUseError, COMPUTER_USE_ERRORS } from './errors.js';
import type { ComputerUseSettings } from './settings.js';
import { canonicalComputerUseAppTarget } from './app-approval-subject.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ComputerUseStatus {
  enabled: boolean;
  providers: ProviderStatus[];
  activeLease?: Lease;
}

// ---------------------------------------------------------------------------
// Action type → capability key mapping
// ---------------------------------------------------------------------------

const ACTION_TO_CAPABILITY: Partial<Record<ActionType, keyof ComputerUseCapabilities>> = {
  click_element: 'elementActions',
  double_click: 'elementDoubleClick',
  click_point: 'pointClick',
  type_text: 'textInput',
  press_key: 'keyboardInput',
  scroll: 'elementActions',
  drag: 'drag',
  perform_secondary_action: 'elementActions',
};

/**
 * Set of capability values that are considered "allowed" — the action may proceed.
 */
const ALLOWED_CAP_VALUES = new Set<string | boolean>([
  true,
  'allowed',
  'semantic',
  'focused',
  'foreground',
  'pidScoped',
]);

// ---------------------------------------------------------------------------
// ComputerUseHost
// ---------------------------------------------------------------------------

export class ComputerUseHost {
  private readonly _providers: ComputerProviderRegistry;
  private readonly _defaultProviderId: string;
  private readonly _leases: ComputerLeaseRegistry;
  private readonly _platform: string;
  private readonly _getSettings: () => ComputerUseSettings;
  private readonly _getAccessMode: (sessionPath?: string) => string;
  private readonly _getPrimaryAgentId: () => string | null;
  private readonly _logger?: Logger;
  private readonly _approvedAppsGlobal = new Set<string>();
  private readonly _approvedAppsBySession = new Map<string, Set<string>>();
  // One-shot approvals: consumed on the next successful createLease for this app.
  private readonly _approvedAppsOnce = new Map<string, Set<string>>();

  constructor(options: {
    providers: ComputerProviderRegistry;
    defaultProviderId: string;
    leases: ComputerLeaseRegistry;
    platform?: string;
    getSettings: () => ComputerUseSettings;
    getAccessMode?: (sessionPath?: string) => string;
    getPrimaryAgentId?: () => string | null;
    logger?: Logger;
  }) {
    this._providers = options.providers;
    this._defaultProviderId = options.defaultProviderId;
    this._leases = options.leases;
    this._platform = options.platform ?? process.platform;
    this._getSettings = options.getSettings;
    this._getAccessMode = options.getAccessMode ?? (() => 'operate');
    this._getPrimaryAgentId = options.getPrimaryAgentId ?? (() => null);
    this._logger = options.logger;
  }

  // -----------------------------------------------------------------------
  // Runtime validation
  // -----------------------------------------------------------------------

  private _assertRuntimeAllowed(ctx: Ctx): void {
    // 1. Global enabled flag
    if (this._getSettings().enabled !== true) {
      throw computerUseError('DISABLED', COMPUTER_USE_ERRORS.DISABLED);
    }

    // 2. Primary-agent restriction
    const allowedAgentIds = this._getSettings().allowedAgents;
    if (allowedAgentIds.includes('*')) {
      return;
    }
    if (allowedAgentIds.length > 0 && !allowedAgentIds.includes(ctx.agentId ?? '')) {
      throw computerUseError(
        'DISABLED',
        'This agent is not allowed to use Computer Use',
      );
    }
    const primaryAgentId = allowedAgentIds.length > 0 ? null : this._getPrimaryAgentId();
    if (primaryAgentId != null && ctx.agentId !== primaryAgentId) {
      throw computerUseError(
        'DISABLED',
        'Only the primary agent can use Computer Use',
      );
    }

    // 3. Read-only session check
    if ((ctx.accessMode ?? this._getAccessMode(ctx.sessionPath)) === 'read-only') {
      throw computerUseError(
        'DISABLED',
        'Computer Use unavailable in read-only sessions',
      );
    }
  }

  // -----------------------------------------------------------------------
  // Provider resolution
  // -----------------------------------------------------------------------

  private _resolveProviderId(ctx: Ctx, target: Target): string {
    return resolveComputerProviderId({
      explicitProviderId: target.providerId ?? ctx.providerId ?? null,
      settings: this._getSettings(),
      platform: this._platform,
      defaultProviderId: this._defaultProviderId,
      hasProvider: (id) => this._providers.has(id),
    });
  }

  // -----------------------------------------------------------------------
  // Lease resolution
  // -----------------------------------------------------------------------

  private _resolveActiveLease(
    ctx: Ctx,
    leaseId: string | null | undefined,
  ): Lease {
    if (leaseId) {
      return this._leases.requireActiveLease(ctx, leaseId);
    }

    // No explicit leaseId — try to find an active lease for this session
    const active = this._leases.getActiveLeaseFor(ctx);
    if (active) return active;

    // No active lease — check whether there was one that has been released
    const last = this._leases.getLastLeaseFor(ctx);
    if (!last) {
      throw computerUseError(
        'LEASE_NOT_FOUND',
        COMPUTER_USE_ERRORS.LEASE_NOT_FOUND,
      );
    }

    // A lease exists but isn't active — it was released or stopping
    throw computerUseError(
      'LEASE_RELEASED',
      COMPUTER_USE_ERRORS.LEASE_RELEASED,
    );
  }

  // -----------------------------------------------------------------------
  // App approval check
  // -----------------------------------------------------------------------

  private _assertAppApproved(
    provider: ComputerUseProvider,
    _providerId: string,
    target: Target,
    ctx?: Ctx,
  ): void {
    // Isolated (mock/sandbox) providers skip app approval
    if (provider.capabilities.isolated) return;

    const appId =
      target.appId ??
      target.appName ??
      (target.pid != null ? `pid:${target.pid}` : undefined) ??
      (target.processId != null ? `pid:${target.processId}` : undefined);

    if (appId && !this.isAppApproved(ctx ?? {}, appId)) {
      throw computerUseError(
        'APP_APPROVAL_REQUIRED',
        COMPUTER_USE_ERRORS.APP_APPROVAL_REQUIRED,
        { appId },
      );
    }
  }

  isAppApproved(ctx: Ctx, appId: string): boolean {
    const canonicalAppId = canonicalComputerUseAppTarget(appId);
    const allowedApps = this._getSettings().allowedApps;
    const canonicalAllowedApps = allowedApps.map(app => canonicalComputerUseAppTarget(app));
    if (allowedApps.includes('*') || canonicalAllowedApps.includes(canonicalAppId)) {
      try { require('node:fs').appendFileSync('/tmp/cu-debug.log', `[${new Date().toISOString()}] isAppApproved: ${appId} -> ${canonicalAppId} ALLOWED by allowedApps [${allowedApps.join(',')}]\n`); } catch {}
      return true;
    }
    if (this._approvedAppsGlobal.has(canonicalAppId)) {
      try { require('node:fs').appendFileSync('/tmp/cu-debug.log', `[${new Date().toISOString()}] isAppApproved: ${appId} -> ${canonicalAppId} ALLOWED by global set\n`); } catch {}
      return true;
    }

    const sessionKey = ctx.sessionPath ?? '';

    // Check one-shot approvals (consumed on use)
    const onceSet = this._approvedAppsOnce.get(sessionKey);
    if (onceSet?.has(canonicalAppId)) {
      try { require('node:fs').appendFileSync('/tmp/cu-debug.log', `[${new Date().toISOString()}] isAppApproved: ${appId} -> ${canonicalAppId} ALLOWED by once\n`); } catch {}
      return true;
    }

    const result = this._approvedAppsBySession.get(sessionKey)?.has(canonicalAppId) === true;
    try { require('node:fs').appendFileSync('/tmp/cu-debug.log', `[${new Date().toISOString()}] isAppApproved: ${appId} -> ${canonicalAppId} result=${result} allowedApps=[${allowedApps.join(',')}] sessionKey="${sessionKey}" globalSize=${this._approvedAppsGlobal.size} sessionSize=${this._approvedAppsBySession.get(sessionKey)?.size ?? 0} onceSize=${onceSet?.size ?? 0}\n`); } catch {}
    return result;
  }

  /** Consume the one-shot approval for an app (called after successful createLease). */
  private _consumeApproveOnce(ctx: Ctx, appId: string): void {
    const canonicalAppId = canonicalComputerUseAppTarget(appId);
    const sessionKey = ctx.sessionPath ?? '';
    this._approvedAppsOnce.get(sessionKey)?.delete(canonicalAppId);
  }

  approveApp(ctx: Ctx, appId: string, scope: 'session' | 'global' | 'once' = 'session'): void {
    const canonicalAppId = canonicalComputerUseAppTarget(appId);
    if (scope === 'global') {
      this._approvedAppsGlobal.add(canonicalAppId);
      return;
    }
    if (scope === 'once') {
      const sessionKey = ctx.sessionPath ?? '';
      const apps = this._approvedAppsOnce.get(sessionKey) ?? new Set<string>();
      apps.add(canonicalAppId);
      this._approvedAppsOnce.set(sessionKey, apps);
      return;
    }

    const sessionKey = ctx.sessionPath ?? '';
    const apps = this._approvedAppsBySession.get(sessionKey) ?? new Set<string>();
    apps.add(canonicalAppId);
    this._approvedAppsBySession.set(sessionKey, apps);
  }

  // -----------------------------------------------------------------------
  // Capability assertion
  // -----------------------------------------------------------------------

  private _assertCapability(
    capabilities: ComputerUseCapabilities,
    action: Action,
  ): void {
    const capKey = ACTION_TO_CAPABILITY[action.type];
    if (!capKey) {
      // No capability mapping for this action type (e.g. stop) — allow through
      return;
    }

    const value = capabilities[capKey] as string | boolean;

    // Values that indicate the action is supported
    if (ALLOWED_CAP_VALUES.has(value)) return;

    // Foreground required
    if (value === 'foreground' || value === 'requiresForeground') {
      throw computerUseError(
        'ACTION_REQUIRES_FOREGROUND',
        COMPUTER_USE_ERRORS.ACTION_REQUIRES_FOREGROUND,
        { action: action.type, capability: capKey },
      );
    }

    // Input-injection approval required
    if (value === 'requiresApproval') {
      throw computerUseError(
        'ACTION_REQUIRES_INPUT_INJECTION_APPROVAL',
        COMPUTER_USE_ERRORS.ACTION_REQUIRES_INPUT_INJECTION_APPROVAL,
        { action: action.type, capability: capKey },
      );
    }

    // Everything else (false, 'unsupported', etc.) → unsupported
    throw computerUseError(
      'CAPABILITY_UNSUPPORTED',
      COMPUTER_USE_ERRORS.CAPABILITY_UNSUPPORTED,
      { action: action.type, capability: capKey, value },
    );
  }

  // -----------------------------------------------------------------------
  // Lease lifecycle helpers
  // -----------------------------------------------------------------------

  /**
   * Check whether an already-active lease can be reused, or release it for
   * takeover by a different app.
   */
  private _reuseOrReplaceActiveLease(
    ctx: Ctx,
    providerId: string,
    target: Target,
  ): Lease | null {
    const active = this._leases.getActiveLease();
    if (!active) return null;

    // Same owner and same target → reuse
    const sameOwner =
      active.sessionPath === (ctx.sessionPath ?? '') &&
      active.agentId === (ctx.agentId ?? '');
    const sameTarget =
      active.providerId === providerId &&
      active.appId === (target.appId ?? target.appName ?? '');

    if (sameOwner && sameTarget) {
      return active;
    }

    // Different session/app → release for takeover
    this._releaseLeaseForTakeover(ctx, active);
    return null;
  }

  /**
   * Release a lease so another session can take over. Fire-and-forget the
   * provider cleanup so a provider error never blocks a takeover.
   */
  private _releaseLeaseForTakeover(ctx: Ctx, lease: Lease): void {
    this._leases.releaseLeaseRecord(lease);

    try {
      const provider = this._providers.require(lease.providerId);
      // Fire-and-forget: provider errors should never block takeover
      provider.stop(ctx, lease).catch(() => {});
      provider.releaseLease(ctx, lease).catch(() => {});
    } catch {
      // Fail-open — the lease record is already marked released
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Get overall status of all providers. */
  async getStatus(ctx: Ctx): Promise<ComputerUseStatus> {
    const providerStatuses = await Promise.all(
      this._providers.list().map(async (p) => {
        try {
          return await p.getStatus(ctx);
        } catch {
          return {
            providerId: p.providerId,
            available: false,
            permissions: [],
            message: 'Provider error',
          } satisfies ProviderStatus;
        }
      }),
    );

    const activeLease = this._leases.getActiveLease() ?? undefined;

    return {
      enabled: this._getSettings().enabled,
      providers: providerStatuses,
      activeLease,
    };
  }

  /** List available apps on the target machine. */
  async listApps(
    ctx: Ctx,
    providerId?: string | null,
  ): Promise<AppInfo[]> {
    this._assertRuntimeAllowed(ctx);

    const pid = providerId ?? this._resolveProviderId(ctx, {});
    const provider = this._providers.require(pid);
    return provider.listApps(ctx);
  }

  /** Create a lease to control an app. */
  async createLease(ctx: Ctx, target: Target): Promise<Lease> {
    this._assertRuntimeAllowed(ctx);

    const providerId = this._resolveProviderId(ctx, target);
    const provider = this._providers.require(providerId);
    this._logger?.debug({
      providerId,
      target,
      sessionPath: ctx.sessionPath,
      agentId: ctx.agentId,
    }, 'Computer Use createLease requested');

    // activateOnly skips app approval and launch — just focuses an existing window
    if (!target.activateOnly) {
      this._assertAppApproved(provider, providerId, target, ctx);
    }

    // Only reuse for activateOnly (focus_app). For open_app, always create a
    // fresh lease so the provider can re-launch the app if it was closed.
    if (target.activateOnly) {
      const existing = this._reuseOrReplaceActiveLease(ctx, providerId, target);
      if (existing) return existing;
    }

    // Release any stale lease for the same target before creating a new one
    const active = this._leases.getActiveLease();
    if (active && active.providerId === providerId && active.appId === (target.appId ?? target.appName ?? '')) {
      this._releaseLeaseForTakeover(ctx, active);
    }

    // Create a new lease through the provider
    const providerStart = Date.now();
    this._logger?.debug(
      { providerId, appId: target.appId ?? target.appName, target },
      'Computer Use calling provider.createLease',
    );
    const providerLease = await provider.createLease(ctx, target);
    this._logger?.info(
      { providerId, appId: providerLease.appId, elapsedMs: Date.now() - providerStart },
      'Computer Use provider.createLease completed',
    );

    // Consume one-shot approval for this app (approve_once)
    const approveOnceAppId = target.appId ?? target.appName;
    if (approveOnceAppId) {
      this._consumeApproveOnce(ctx, approveOnceAppId);
    }

    const lease = this._leases.createLease(ctx, {
      ...providerLease,
      providerId,
      appId: providerLease.appId || target.appId || '',
    });

    this._logger?.info(
      { leaseId: lease.leaseId, providerId, appId: lease.appId, target },
      'Computer Use lease created',
    );

    return lease;
  }

  /** Close an app by name. Delegates to the current provider. */
  async closeApp(ctx: Ctx, target: string): Promise<void> {
    const providerId = this._resolveProviderId(ctx, { appName: target });
    const provider = this._providers.require(providerId);
    if (!provider.closeApp) {
      throw computerUseError(
        'CAPABILITY_UNSUPPORTED',
        `close_app is not supported by provider "${providerId}"`,
      );
    }
    await provider.closeApp(ctx, target);
  }

  /** Get the current screen state (screenshot + UI elements). */
  async getAppState(
    ctx: Ctx,
    leaseId?: string | null,
  ): Promise<AppState & { snapshotId: string; leaseId: string; providerId: string; allowedActions: ActionType[] }> {
    this._assertRuntimeAllowed(ctx);

    const lease = this._resolveActiveLease(ctx, leaseId);
    this._logger?.debug({
      leaseId: lease.leaseId,
      requestedLeaseId: leaseId,
      providerId: lease.providerId,
      appId: lease.appId,
      sessionPath: ctx.sessionPath,
      agentId: ctx.agentId,
    }, 'Computer Use getAppState requested');
    const provider = this._providers.require(lease.providerId);

    const stateStart = Date.now();
    const state = await provider.getAppState(ctx, lease);
    this._logger?.info(
      { leaseId: lease.leaseId, providerId: lease.providerId, elementCount: state.elements.length, elapsedMs: Date.now() - stateStart },
      'Computer Use provider.getAppState completed',
    );
    const recorded = this._leases.recordSnapshot(ctx, lease.leaseId, state);

    return {
      ...state,
      snapshotId: recorded.snapshotId,
      leaseId: lease.leaseId,
      providerId: lease.providerId,
      allowedActions: [...lease.allowedActions],
    };
  }

  /** Perform an action (click, type, scroll, etc.). */
  async performAction(
    ctx: Ctx,
    leaseId: string | null,
    action: Action,
  ): Promise<ActionResult> {
    this._assertRuntimeAllowed(ctx);

    const lease = this._resolveActiveLease(ctx, leaseId);
    this._logger?.debug({
      leaseId: lease.leaseId,
      requestedLeaseId: leaseId,
      providerId: lease.providerId,
      appId: lease.appId,
      actionType: action.type,
      sessionPath: ctx.sessionPath,
      agentId: ctx.agentId,
    }, 'Computer Use performAction requested');

    // Policy check: is this action type allowed by the lease?
    if (
      lease.allowedActions.length > 0 &&
      !lease.allowedActions.includes(action.type)
    ) {
      throw computerUseError(
        'ACTION_BLOCKED_BY_POLICY',
        COMPUTER_USE_ERRORS.ACTION_BLOCKED_BY_POLICY,
        { actionType: action.type, allowedActions: lease.allowedActions },
      );
    }

    // Validate snapshot if one was referenced
    let validatedSnapshot: (AppState & { snapshotId: string }) | null = null;
    if (action.snapshotId) {
      validatedSnapshot = this._leases.validateSnapshot(
        ctx,
        lease.leaseId,
        action.snapshotId,
      );
    }

    const provider = this._providers.require(lease.providerId);

    // Capability check
    this._assertCapability(provider.capabilities, action);

    // Element lookup
    let actionForProvider = action;
    if (action.elementId) {
      const snap =
        validatedSnapshot ??
        (lease.lastSnapshotId
          ? this._leases.validateSnapshot(ctx, lease.leaseId, lease.lastSnapshotId)
          : null);

      if (!snap) {
        throw computerUseError(
          'STALE_SNAPSHOT',
          COMPUTER_USE_ERRORS.STALE_SNAPSHOT,
          { leaseId: lease.leaseId, elementId: action.elementId },
        );
      }

      const element = snap.elements.find(
        (e) => e.elementId === action.elementId,
      );
      if (!element) {
        throw computerUseError(
          'TARGET_NOT_FOUND',
          COMPUTER_USE_ERRORS.TARGET_NOT_FOUND,
          { elementId: action.elementId },
        );
      }
      actionForProvider = { ...action, snapshotElement: element };
    }

    const actionStart = Date.now();
    this._logger?.debug(
      { leaseId: lease.leaseId, providerId: lease.providerId, actionType: action.type },
      'Computer Use calling provider.performAction',
    );
    const result = await provider.performAction(ctx, lease, actionForProvider);
    this._logger?.info(
      { leaseId: lease.leaseId, providerId: lease.providerId, actionType: action.type, ok: result.ok, elapsedMs: Date.now() - actionStart },
      'Computer Use provider.performAction completed',
    );

    this._logger?.info(
      { leaseId: lease.leaseId, actionType: action.type, ok: result.ok },
      'Performed action',
    );

    return result;
  }

  /** Release a lease. */
  async releaseLease(ctx: Ctx, leaseId: string): Promise<boolean> {
    const lease = this._leases.getLease(ctx, leaseId);
    if (!lease) return false;

    try {
      const provider = this._providers.require(lease.providerId);
      await provider.releaseLease(ctx, lease);
    } catch (err) {
      this._logger?.debug({ err, leaseId }, 'Error releasing lease from provider');
    }

    this._leases.releaseLease(ctx, leaseId);
    return true;
  }

  /** Stop controlling and release. */
  async stop(ctx: Ctx, leaseId?: string | null): Promise<boolean> {
    const lease = this._resolveActiveLease(ctx, leaseId);
    const provider = this._providers.require(lease.providerId);

    try {
      await provider.stop(ctx, lease);
    } catch (err) {
      this._logger?.warn({ err, leaseId: lease.leaseId }, 'Error stopping lease');
    }

    this._leases.releaseLease(ctx, lease.leaseId);
    return true;
  }

  /** Release all leases for a session (e.g. on disconnect). */
  abortSession(sessionPath: string): void {
    this._leases.releaseBySession(sessionPath);
  }
}
