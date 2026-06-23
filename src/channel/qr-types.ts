/**
 * Shared QR code configuration types.
 *
 * Used by channel extensions (feishu, wechat, qq, telegram) and the
 * QR exchange routes to provide a unified QR-based credential setup flow.
 */

/** QR session state machine status */
export type QrSessionStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

/** Response from QR generation endpoint (POST /api/channels/:channel/qr) */
export interface QrGenerateResponse {
  ok: boolean;
  /** Unique session identifier for polling and credential submission */
  sessionId: string;
  /** Base64 PNG data URL of the QR code image */
  qrcodeImageDataUrl: string;
  /** Optional expiry time in seconds */
  expiresIn?: number;
  /** Human-readable instructions to display alongside the QR code */
  instructions?: string;
  /** Alternative: direct URL to open (e.g. BotFather deep link) */
  directUrl?: string;
  /** Error message when ok is false */
  error?: string;
}

/** Response from QR poll endpoint (POST /api/channels/:channel/qr/poll) */
export interface QrPollResponse {
  status: QrSessionStatus;
  /** Present only when status === 'confirmed' */
  credentials?: Record<string, string>;
  /** Convenience field for WeChat iLink flow */
  botToken?: string;
  /** Error message when status === 'error' */
  error?: string;
}

/** In-memory QR session (managed by QrSessionStore) */
export interface QrSession {
  id: string;
  channel: 'feishu' | 'wechat' | 'qq' | 'telegram';
  status: QrSessionStatus;
  credentials?: Record<string, string>;
  createdAt: number;
  expiresAt: number;
}
