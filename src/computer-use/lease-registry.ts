// src/computer-use/lease-registry.ts

import { randomUUID } from 'node:crypto';
import type { Ctx, Lease, AppState, ActionType } from './types.js';
import { computerUseError, COMPUTER_USE_ERRORS } from './errors.js';

function leaseKey(
  sessionPath: string | undefined | null,
  agentId: string | undefined | null,
  leaseId: string,
): string {
  return `${sessionPath || ''}\0${agentId || ''}\0${leaseId}`;
}

function sessionKey(
  sessionPath: string | undefined | null,
  agentId: string | undefined | null,
): string {
  return `${sessionPath || ''}\0${agentId || ''}`;
}

function snapshotKey(
  sessionPath: string | undefined | null,
  agentId: string | undefined | null,
  snapshotId: string,
): string {
  return `${sessionPath || ''}\0${agentId || ''}\0${snapshotId}`;
}

interface SnapshotRecord extends AppState {
  snapshotId: string;
  leaseId: string;
  capturedAt: string;
}

export class ComputerLeaseRegistry {
  private readonly leases = new Map<string, Lease>();
  private readonly snapshots = new Map<string, SnapshotRecord>();

  /** O(1) lookup: composite key → active lease key for the session. */
  private readonly activeBySession = new Map<string, string>();
  /** O(1) lookup: composite key → lease keys belonging to the session. */
  private readonly leasesBySession = new Map<string, Set<string>>();
  /** Global active lease key (null when no active lease). */
  private activeLeaseKey: string | null = null;

  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly snapshotIdFactory: () => string;

  constructor(options?: {
    now?: () => number;
    idFactory?: () => string;
    snapshotIdFactory?: () => string;
  }) {
    this.now = options?.now ?? (() => Date.now());
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.snapshotIdFactory = options?.snapshotIdFactory ?? (() => randomUUID());
  }

  createLease(
    ctx: Ctx,
    target: {
      providerId: string;
      appId?: string;
      windowId?: string | null;
      allowedActions?: string[];
      providerState?: Record<string, unknown>;
      expiresAt?: string | null;
      leaseId?: string;
    },
  ): Lease {
    const id = target.leaseId ?? this.idFactory();

    const lease: Lease = {
      leaseId: id,
      sessionPath: ctx.sessionPath ?? '',
      agentId: ctx.agentId ?? '',
      providerId: target.providerId,
      appId: target.appId ?? '',
      windowId: target.windowId ?? undefined,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: target.expiresAt ?? undefined,
      status: 'active',
      allowedActions: (target.allowedActions ? [...target.allowedActions] : []) as ActionType[],
      providerState:
        target.providerState != null && typeof target.providerState === 'object'
          ? { ...target.providerState }
          : {},
    };

    const key = leaseKey(ctx.sessionPath, ctx.agentId, id);
    this.leases.set(key, lease);

    // Maintain O(1) indexes
    this.activeLeaseKey = key;
    this.activeBySession.set(sessionKey(ctx.sessionPath, ctx.agentId), key);

    const sk = sessionKey(ctx.sessionPath, ctx.agentId);
    const set = this.leasesBySession.get(sk) ?? new Set();
    set.add(key);
    this.leasesBySession.set(sk, set);

    return lease;
  }

  getActiveLease(): Lease | null {
    if (this.activeLeaseKey) {
      const lease = this.leases.get(this.activeLeaseKey);
      if (lease?.status === 'active') return lease;
      // Stale index — rebuild
      this.activeLeaseKey = null;
    }
    // Fallback scan (shouldn't normally be needed)
    for (const lease of this.leases.values()) {
      if (lease.status === 'active') {
        this.activeLeaseKey = leaseKey(lease.sessionPath, lease.agentId, lease.leaseId);
        return lease;
      }
    }
    return null;
  }

  getActiveLeaseFor(ctx: Ctx): Lease | null {
    const sk = sessionKey(ctx.sessionPath, ctx.agentId);
    const key = this.activeBySession.get(sk);
    if (key) {
      const lease = this.leases.get(key);
      if (lease?.status === 'active') return lease;
      this.activeBySession.delete(sk);
    }
    // Fallback scan
    const sp = ctx.sessionPath ?? '';
    const ag = ctx.agentId ?? '';
    for (const lease of this.leases.values()) {
      if (lease.sessionPath === sp && lease.agentId === ag && lease.status === 'active') {
        this.activeBySession.set(sk, leaseKey(sp, ag, lease.leaseId));
        return lease;
      }
    }
    return null;
  }

  getLastLeaseFor(ctx: Ctx): Lease | null {
    const sp = ctx.sessionPath ?? '';
    const ag = ctx.agentId ?? '';
    const sk = sessionKey(ctx.sessionPath, ctx.agentId);
    const keys = this.leasesBySession.get(sk);
    if (keys) {
      let last: Lease | null = null;
      for (const key of keys) {
        const lease = this.leases.get(key);
        if (lease) last = lease;
      }
      return last;
    }
    // Fallback scan
    let last: Lease | null = null;
    for (const lease of this.leases.values()) {
      if (lease.sessionPath === sp && lease.agentId === ag) {
        last = lease;
      }
    }
    return last;
  }

  getLease(ctx: Ctx, leaseId: string): Lease | null {
    const key = leaseKey(ctx.sessionPath, ctx.agentId, leaseId);
    return this.leases.get(key) ?? null;
  }

  requireActiveLease(ctx: Ctx, leaseId: string): Lease {
    const lease = this.getLease(ctx, leaseId);
    if (!lease) {
      throw computerUseError(
        'LEASE_NOT_FOUND',
        COMPUTER_USE_ERRORS.LEASE_NOT_FOUND,
      );
    }
    if (lease.status !== 'active') {
      throw computerUseError(
        'LEASE_RELEASED',
        COMPUTER_USE_ERRORS.LEASE_RELEASED,
      );
    }
    return lease;
  }

  releaseLease(ctx: Ctx, leaseId: string): boolean {
    const key = leaseKey(ctx.sessionPath, ctx.agentId, leaseId);
    const lease = this.leases.get(key);
    if (!lease) return false;
    lease.status = 'released';

    // Update indexes
    if (this.activeLeaseKey === key) this.activeLeaseKey = null;
    this.activeBySession.delete(sessionKey(ctx.sessionPath, ctx.agentId));

    return true;
  }

  releaseLeaseRecord(lease: Lease): boolean {
    lease.status = 'released';

    const key = leaseKey(lease.sessionPath, lease.agentId, lease.leaseId);
    if (this.activeLeaseKey === key) this.activeLeaseKey = null;
    this.activeBySession.delete(sessionKey(lease.sessionPath, lease.agentId));

    return true;
  }

  markStopping(ctx: Ctx, leaseId: string): Lease {
    const key = leaseKey(ctx.sessionPath, ctx.agentId, leaseId);
    const lease = this.leases.get(key);
    if (!lease) {
      throw computerUseError(
        'LEASE_NOT_FOUND',
        COMPUTER_USE_ERRORS.LEASE_NOT_FOUND,
      );
    }
    lease.status = 'stopping';
    return lease;
  }

  recordSnapshot(
    ctx: Ctx,
    leaseId: string,
    snapshot: AppState & { snapshotId?: string; capturedAt?: string },
  ): AppState & { snapshotId: string } {
    const leaseKeyStr = leaseKey(ctx.sessionPath, ctx.agentId, leaseId);
    const lease = this.leases.get(leaseKeyStr);
    if (!lease) {
      throw computerUseError(
        'LEASE_NOT_FOUND',
        COMPUTER_USE_ERRORS.LEASE_NOT_FOUND,
      );
    }

    const snapshotId = snapshot.snapshotId ?? this.snapshotIdFactory();
    const capturedAt =
      snapshot.capturedAt ?? new Date(this.now()).toISOString();

    const record: SnapshotRecord = {
      mode: snapshot.mode,
      screenshot: snapshot.screenshot,
      display: snapshot.display,
      elements: snapshot.elements,
      focusedElementId: snapshot.focusedElementId,
      windowTitle: snapshot.windowTitle,
      snapshotId,
      leaseId,
      capturedAt,
    };

    const snapKey = snapshotKey(ctx.sessionPath, ctx.agentId, snapshotId);
    this.snapshots.set(snapKey, record);
    lease.lastSnapshotId = snapshotId;

    return { ...snapshot, snapshotId };
  }

  validateSnapshot(
    ctx: Ctx,
    leaseId: string,
    snapshotId: string,
  ): AppState & { snapshotId: string } {
    const snapKey = snapshotKey(ctx.sessionPath, ctx.agentId, snapshotId);
    const record = this.snapshots.get(snapKey);

    if (!record) {
      throw computerUseError(
        'STALE_SNAPSHOT',
        COMPUTER_USE_ERRORS.STALE_SNAPSHOT,
        { leaseId, snapshotId },
      );
    }

    if (record.leaseId !== leaseId) {
      throw computerUseError(
        'STALE_SNAPSHOT',
        COMPUTER_USE_ERRORS.STALE_SNAPSHOT,
        { leaseId, snapshotId, expectedLeaseId: record.leaseId },
      );
    }

    const leaseKeyStr = leaseKey(ctx.sessionPath, ctx.agentId, leaseId);
    const lease = this.leases.get(leaseKeyStr);
    if (lease && lease.lastSnapshotId !== snapshotId) {
      throw computerUseError(
        'STALE_SNAPSHOT',
        COMPUTER_USE_ERRORS.STALE_SNAPSHOT,
        { leaseId, snapshotId, lastSnapshotId: lease.lastSnapshotId },
      );
    }

    return {
      mode: record.mode,
      screenshot: record.screenshot,
      display: record.display,
      elements: record.elements,
      focusedElementId: record.focusedElementId,
      windowTitle: record.windowTitle,
      snapshotId: record.snapshotId,
    };
  }

  releaseBySession(sessionPath: string): void {
    // Use index when available, fall back to full scan
    for (const [sk, keys] of this.leasesBySession) {
      if (!sk.startsWith(`${sessionPath}\0`)) continue;
      for (const key of keys) {
        const lease = this.leases.get(key);
        if (lease && lease.status === 'active') {
          lease.status = 'released';
        }
      }
    }
    // Fallback: scan all leases for matching sessionPath
    for (const [, lease] of this.leases) {
      if (lease.sessionPath === sessionPath && lease.status === 'active') {
        lease.status = 'released';
      }
    }
  }
}
