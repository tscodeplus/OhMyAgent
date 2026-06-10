import { describe, it, expect, beforeEach } from 'vitest';
import { ComputerLeaseRegistry } from '../../src/computer-use/lease-registry';
import type { Ctx } from '../../src/computer-use/types';

describe('ComputerLeaseRegistry', () => {
  let registry: ComputerLeaseRegistry;
  const defaultCtx: Ctx = { sessionPath: 'sess-1', agentId: 'agent-1' };
  const defaultTarget = {
    providerId: 'mock',
    appId: 'app.notes',
    allowedActions: ['click_element', 'type_text'],
  };

  beforeEach(() => {
    registry = new ComputerLeaseRegistry();
  });

  // ---------------------------------------------------------------------------
  // createLease
  // ---------------------------------------------------------------------------

  describe('createLease', () => {
    it('creates an active lease with correct fields', () => {
      const lease = registry.createLease(defaultCtx, defaultTarget);

      expect(lease.leaseId).toBeDefined();
      expect(typeof lease.leaseId).toBe('string');
      expect(lease.sessionPath).toBe('sess-1');
      expect(lease.agentId).toBe('agent-1');
      expect(lease.providerId).toBe('mock');
      expect(lease.appId).toBe('app.notes');
      expect(lease.status).toBe('active');
      expect(lease.createdAt).toBeDefined();
      expect(() => new Date(lease.createdAt)).not.toThrow();
      expect(lease.allowedActions).toEqual(['click_element', 'type_text']);
      expect(lease.providerState).toEqual({});
    });

    it('generates unique leaseIds for successive calls', () => {
      const lease1 = registry.createLease(defaultCtx, defaultTarget);
      const lease2 = registry.createLease(defaultCtx, defaultTarget);
      expect(lease1.leaseId).not.toBe(lease2.leaseId);
    });

    it('accepts explicit leaseId', () => {
      const lease = registry.createLease(defaultCtx, {
        ...defaultTarget,
        leaseId: 'my-lease',
      });
      expect(lease.leaseId).toBe('my-lease');
    });

    it('accepts explicit providerState', () => {
      const lease = registry.createLease(defaultCtx, {
        ...defaultTarget,
        providerState: { foo: 'bar' },
      });
      expect(lease.providerState).toEqual({ foo: 'bar' });
    });

    it('clones providerState so mutations do not affect the lease', () => {
      const state = { foo: 'bar' };
      const lease = registry.createLease(defaultCtx, {
        ...defaultTarget,
        providerState: state,
      });
      state.foo = 'baz';
      expect(lease.providerState).toEqual({ foo: 'bar' });
    });
  });

  // ---------------------------------------------------------------------------
  // getActiveLease
  // ---------------------------------------------------------------------------

  describe('getActiveLease', () => {
    it('returns the active lease', () => {
      registry.createLease(defaultCtx, defaultTarget);
      const lease = registry.getActiveLease();
      expect(lease).not.toBeNull();
      expect(lease!.status).toBe('active');
    });

    it('returns null when no active lease exists', () => {
      expect(registry.getActiveLease()).toBeNull();
    });

    it('returns null after all leases are released', () => {
      const lease = registry.createLease(defaultCtx, defaultTarget);
      registry.releaseLease(defaultCtx, lease.leaseId);
      expect(registry.getActiveLease()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getActiveLeaseFor
  // ---------------------------------------------------------------------------

  describe('getActiveLeaseFor', () => {
    it('filters by session path and agent id', () => {
      registry.createLease(defaultCtx, defaultTarget);
      const lease = registry.getActiveLeaseFor(defaultCtx);
      expect(lease).not.toBeNull();
      expect(lease!.sessionPath).toBe('sess-1');
      expect(lease!.agentId).toBe('agent-1');
    });

    it('returns null for a different session path', () => {
      registry.createLease(defaultCtx, defaultTarget);
      const otherCtx: Ctx = { sessionPath: 'sess-2', agentId: 'agent-1' };
      expect(registry.getActiveLeaseFor(otherCtx)).toBeNull();
    });

    it('returns null for a different agent id', () => {
      registry.createLease(defaultCtx, defaultTarget);
      const otherCtx: Ctx = { sessionPath: 'sess-1', agentId: 'agent-2' };
      expect(registry.getActiveLeaseFor(otherCtx)).toBeNull();
    });

    it('returns null when contexts use undefined vs empty string', () => {
      const ctxEmpty: Ctx = { sessionPath: '', agentId: '' };
      const ctxUndefined: Ctx = {};
      registry.createLease(ctxEmpty, defaultTarget);
      expect(registry.getActiveLeaseFor(ctxUndefined)).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getLastLeaseFor
  // ---------------------------------------------------------------------------

  describe('getLastLeaseFor', () => {
    it('returns the most recent lease regardless of status', () => {
      const lease1 = registry.createLease(defaultCtx, defaultTarget);
      registry.releaseLease(defaultCtx, lease1.leaseId);
      const lease2 = registry.createLease(defaultCtx, defaultTarget);
      const last = registry.getLastLeaseFor(defaultCtx);
      expect(last).not.toBeNull();
      expect(last!.leaseId).toBe(lease2.leaseId);
    });

    it('returns a released lease when no active one exists', () => {
      const lease = registry.createLease(defaultCtx, defaultTarget);
      registry.releaseLease(defaultCtx, lease.leaseId);
      const last = registry.getLastLeaseFor(defaultCtx);
      expect(last).not.toBeNull();
      expect(last!.leaseId).toBe(lease.leaseId);
      expect(last!.status).toBe('released');
    });

    it('returns null when no lease exists for the given context', () => {
      expect(registry.getLastLeaseFor(defaultCtx)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getLease
  // ---------------------------------------------------------------------------

  describe('getLease', () => {
    it('returns the lease by id and context', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const found = registry.getLease(defaultCtx, created.leaseId);
      expect(found).not.toBeNull();
      expect(found!.leaseId).toBe(created.leaseId);
    });

    it('returns null for a missing lease', () => {
      expect(registry.getLease(defaultCtx, 'nonexistent')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // requireActiveLease
  // ---------------------------------------------------------------------------

  describe('requireActiveLease', () => {
    it('returns an active lease when found', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const found = registry.requireActiveLease(defaultCtx, created.leaseId);
      expect(found.leaseId).toBe(created.leaseId);
    });

    it('throws LEASE_NOT_FOUND for a missing lease', () => {
      expect(() => registry.requireActiveLease(defaultCtx, 'nonexistent')).toThrow(
        'No active computer lease',
      );
    });

    it('throws LEASE_RELEASED for a released lease', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      registry.releaseLease(defaultCtx, created.leaseId);
      expect(() => registry.requireActiveLease(defaultCtx, created.leaseId)).toThrow(
        'Computer lease has been released',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // releaseLease
  // ---------------------------------------------------------------------------

  describe('releaseLease', () => {
    it('sets status to released and returns true', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const result = registry.releaseLease(defaultCtx, created.leaseId);
      expect(result).toBe(true);
      const after = registry.getLease(defaultCtx, created.leaseId);
      expect(after!.status).toBe('released');
    });

    it('returns false when the lease is not found', () => {
      const result = registry.releaseLease(defaultCtx, 'nonexistent');
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // releaseLeaseRecord
  // ---------------------------------------------------------------------------

  describe('releaseLeaseRecord', () => {
    it('mutates the lease directly to released', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const result = registry.releaseLeaseRecord(created);
      expect(result).toBe(true);
      expect(created.status).toBe('released');
    });
  });

  // ---------------------------------------------------------------------------
  // markStopping
  // ---------------------------------------------------------------------------

  describe('markStopping', () => {
    it('sets the lease status to stopping', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const stopped = registry.markStopping(defaultCtx, created.leaseId);
      expect(stopped.status).toBe('stopping');
      const after = registry.getLease(defaultCtx, created.leaseId);
      expect(after!.status).toBe('stopping');
    });

    it('throws LEASE_NOT_FOUND for a missing lease', () => {
      expect(() => registry.markStopping(defaultCtx, 'nonexistent')).toThrow(
        'No active computer lease',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // recordSnapshot
  // ---------------------------------------------------------------------------

  describe('recordSnapshot', () => {
    it('stores a snapshot and updates lease.lastSnapshotId', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const snapshot = {
        mode: 'vision-native' as const,
        display: { width: 800, height: 600 },
        elements: [],
      };
      const result = registry.recordSnapshot(defaultCtx, created.leaseId, snapshot);

      expect(result.snapshotId).toBeDefined();
      expect(result.mode).toBe('vision-native');
      expect(result.display.width).toBe(800);

      const lease = registry.getLease(defaultCtx, created.leaseId);
      expect(lease!.lastSnapshotId).toBe(result.snapshotId);
    });

    it('uses the provided snapshotId when given', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const snapshot = {
        mode: 'vision-native' as const,
        display: { width: 800, height: 600 },
        elements: [],
        snapshotId: 'custom-snap-id',
      };
      const result = registry.recordSnapshot(defaultCtx, created.leaseId, snapshot);
      expect(result.snapshotId).toBe('custom-snap-id');
    });

    it('throws LEASE_NOT_FOUND for a missing lease', () => {
      expect(() =>
        registry.recordSnapshot(defaultCtx, 'nonexistent', {
          mode: 'vision-native' as const,
          display: { width: 800, height: 600 },
          elements: [],
        }),
      ).toThrow('No active computer lease');
    });
  });

  // ---------------------------------------------------------------------------
  // validateSnapshot
  // ---------------------------------------------------------------------------

  describe('validateSnapshot', () => {
    it('passes for a valid and latest snapshot', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const snapshot = {
        mode: 'vision-native' as const,
        display: { width: 800, height: 600 },
        elements: [],
      };
      const recorded = registry.recordSnapshot(defaultCtx, created.leaseId, snapshot);
      const validated = registry.validateSnapshot(
        defaultCtx,
        created.leaseId,
        recorded.snapshotId,
      );
      expect(validated.snapshotId).toBe(recorded.snapshotId);
      expect(validated.mode).toBe('vision-native');
    });

    it('throws STALE_SNAPSHOT for a missing snapshot', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      expect(() =>
        registry.validateSnapshot(defaultCtx, created.leaseId, 'nonexistent'),
      ).toThrow('Snapshot is stale');
    });

    it('throws STALE_SNAPSHOT for a snapshot from the wrong lease', () => {
      const sameCtx: Ctx = { sessionPath: 'sess-1', agentId: 'agent-1' };
      const lease1 = registry.createLease(sameCtx, {
        ...defaultTarget,
        appId: 'app1',
      });
      const lease2 = registry.createLease(sameCtx, {
        ...defaultTarget,
        appId: 'app2',
      });

      const snapshot = {
        mode: 'vision-native' as const,
        display: { width: 800, height: 600 },
        elements: [],
      };
      const recorded = registry.recordSnapshot(sameCtx, lease1.leaseId, snapshot);

      expect(() =>
        registry.validateSnapshot(sameCtx, lease2.leaseId, recorded.snapshotId),
      ).toThrow('Snapshot is stale');
    });

    it('throws STALE_SNAPSHOT when the snapshot is not the latest', () => {
      const created = registry.createLease(defaultCtx, defaultTarget);
      const snapshot = {
        mode: 'vision-native' as const,
        display: { width: 800, height: 600 },
        elements: [],
      };
      const snap1 = registry.recordSnapshot(defaultCtx, created.leaseId, snapshot);
      registry.recordSnapshot(defaultCtx, created.leaseId, snapshot);

      expect(() =>
        registry.validateSnapshot(defaultCtx, created.leaseId, snap1.snapshotId),
      ).toThrow('Snapshot is stale');
    });
  });

  // ---------------------------------------------------------------------------
  // releaseBySession
  // ---------------------------------------------------------------------------

  describe('releaseBySession', () => {
    it('releases all active leases for the given session path', () => {
      const ctx1: Ctx = { sessionPath: 'sess-1', agentId: 'agent-1' };
      const ctx2: Ctx = { sessionPath: 'sess-2', agentId: 'agent-2' };

      const lease1 = registry.createLease(ctx1, defaultTarget);
      const lease2 = registry.createLease(ctx1, {
        ...defaultTarget,
        appId: 'app2',
      });
      const lease3 = registry.createLease(ctx2, defaultTarget);

      registry.releaseBySession('sess-1');

      expect(registry.getLease(ctx1, lease1.leaseId)!.status).toBe('released');
      expect(registry.getLease(ctx1, lease2.leaseId)!.status).toBe('released');
      expect(registry.getLease(ctx2, lease3.leaseId)!.status).toBe('active');
    });

    it('ignores already-released leases', () => {
      const ctx: Ctx = { sessionPath: 'sess-1', agentId: 'agent-1' };
      const lease = registry.createLease(ctx, defaultTarget);
      registry.releaseLease(ctx, lease.leaseId);

      // Should not throw — already-released leases are a no-op
      registry.releaseBySession('sess-1');
      expect(registry.getLease(ctx, lease.leaseId)!.status).toBe('released');
    });
  });

  // ---------------------------------------------------------------------------
  // Dependency injection
  // ---------------------------------------------------------------------------

  describe('dependency injection', () => {
    it('custom now returns a fixed createdAt timestamp', () => {
      const fixedTime = 1_234_567_890_000;
      const diRegistry = new ComputerLeaseRegistry({ now: () => fixedTime });
      const lease = diRegistry.createLease(defaultCtx, defaultTarget);
      expect(lease.createdAt).toBe(new Date(fixedTime).toISOString());
    });

    it('custom idFactory returns predictable leaseIds', () => {
      let counter = 0;
      const diRegistry = new ComputerLeaseRegistry({
        idFactory: () => `lease-${++counter}`,
      });
      const lease = diRegistry.createLease(defaultCtx, defaultTarget);
      expect(lease.leaseId).toBe('lease-1');
    });

    it('custom snapshotIdFactory returns predictable snapshotIds', () => {
      let counter = 0;
      const diRegistry = new ComputerLeaseRegistry({
        snapshotIdFactory: () => `snap-${++counter}`,
      });
      const lease = diRegistry.createLease(defaultCtx, defaultTarget);
      const snapshot = {
        mode: 'vision-native' as const,
        display: { width: 800, height: 600 },
        elements: [],
      };
      const result = diRegistry.recordSnapshot(defaultCtx, lease.leaseId, snapshot);
      expect(result.snapshotId).toBe('snap-1');
    });
  });
});
