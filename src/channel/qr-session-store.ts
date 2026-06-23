/**
 * In-memory QR session store.
 *
 * Manages short-lived QR configuration sessions for all channels.
 * Each session has a unique UUID and expires after a configurable TTL.
 * Expired and completed sessions are automatically pruned every 60 seconds.
 */

import crypto from 'node:crypto';
import type { QrSession, QrSessionStatus } from './qr-types.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // 1 minute

export class QrSessionStore {
  private sessions = new Map<string, QrSession>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
  }

  /**
   * Create a new QR session.
   *
   * @param channel - The channel this session is for.
   * @param ttlMs  - Time-to-live in milliseconds (default: 5 min).
   * @returns The created session.
   */
  create(
    channel: QrSession['channel'],
    ttlMs: number = DEFAULT_TTL_MS,
  ): QrSession {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: QrSession = {
      id,
      channel,
      status: 'waiting',
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Get a session by ID.
   *
   * @returns The session, or undefined if not found or expired.
   */
  get(id: string): QrSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      return session;
    }
    return session;
  }

  /**
   * Update the status of a session.
   */
  updateStatus(id: string, status: QrSessionStatus): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
    }
  }

  /**
   * Store credentials on a session and mark it as confirmed.
   */
  setCredentials(id: string, credentials: Record<string, string>): void {
    const session = this.sessions.get(id);
    if (session) {
      session.credentials = credentials;
      session.status = 'confirmed';
    }
  }

  /**
   * Mark all waiting/sessions for a channel as expired (e.g. when a new
   * QR is generated, invalidate previous ones).
   */
  invalidateChannel(channel: QrSession['channel']): void {
    for (const session of this.sessions.values()) {
      if (
        session.channel === channel &&
        (session.status === 'waiting' || session.status === 'scanned')
      ) {
        session.status = 'expired';
      }
    }
  }

  /**
   * Delete a specific session.
   */
  delete(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Return the number of active sessions (for debugging).
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Periodic cleanup: remove expired+completed sessions, mark stale
   * waiting sessions as expired.
   */
  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        if (session.status === 'waiting' || session.status === 'scanned') {
          session.status = 'expired';
        }
        // Remove expired and confirmed sessions after a grace period
        if (
          session.status === 'expired' ||
          session.status === 'confirmed' ||
          session.status === 'error'
        ) {
          this.sessions.delete(id);
        }
      }
    }
  }

  /**
   * Stop the prune timer and clear all sessions.
   * Call during graceful shutdown.
   */
  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.sessions.clear();
  }
}
