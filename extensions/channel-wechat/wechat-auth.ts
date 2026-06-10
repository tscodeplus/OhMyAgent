/**
 * iLink QR code login.
 *
 * Generates a QR code for the user to scan with WeChat, then long-polls
 * the status until the user confirms (or the QR expires).
 *
 * These functions are called directly from REST routes managed by the
 * extension entry point — they are independent of the poller lifecycle.
 */

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { ILQrcodeResponse, ILQrcodeStatusResponse } from './wechat-types.js';

const QR_POLL_TIMEOUT_MS = 40_000;

/** Header for QR code login requests (no Authorization needed). */
function loginHeaders(): Record<string, string> {
  return { 'iLink-App-ClientVersion': '1' };
}

/**
 * Request a new QR code from the iLink API.
 *
 * @param apiBase  iLink API base URL (e.g. https://ilinkai.weixin.qq.com).
 * @returns        qrcodeId (opaque identifier for status polling) and
 *                 qrcodeImageDataUrl (base64 PNG data URL for display).
 */
export async function getQrcode(
  apiBase: string,
): Promise<{ qrcodeId: string; qrcodeImageDataUrl: string }> {
  const url = `${apiBase}/ilink/bot/get_bot_qrcode?bot_type=3`;

  const res = await fetch(url, { headers: loginHeaders() });
  if (!res.ok) {
    throw new Error(
      `QR code request failed: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const data: ILQrcodeResponse = (await res.json()) as ILQrcodeResponse;
  if (!data.qrcode) {
    throw new Error('iLink server did not return a qrcode id');
  }

  const qrText = data.qrcode_img_content || data.qrcode;
  const qrcodeImageDataUrl = await QRCode.toDataURL(qrText, {
    width: 280,
    margin: 2,
  });

  return { qrcodeId: data.qrcode, qrcodeImageDataUrl };
}

/**
 * Long-poll the QR code scan status.
 *
 * The iLink server holds the connection for up to ~35 seconds. This
 * function uses an AbortSignal with a 40-second timeout. If the server
 * does not respond within that window, `{ status: 'waiting' }` is returned
 * and the caller should poll again.
 *
 * @param apiBase    iLink API base URL.
 * @param qrcodeId   The qrcode id obtained from getQrcode().
 * @param signal     External AbortSignal (e.g. from HTTP request lifecycle).
 * @returns          Status object; `confirmed` includes the bot token.
 */
export async function pollQrcodeStatus(
  apiBase: string,
  qrcodeId: string,
  signal: AbortSignal,
): Promise<{
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
  botToken?: string;
  botId?: string;
  userId?: string;
  baseUrl?: string;
}> {
  const url = `${apiBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;

  try {
    const res = await fetch(url, {
      headers: loginHeaders(),
      signal: AbortSignal.timeout(QR_POLL_TIMEOUT_MS),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      console.error('QR poll HTTP error:', res.status, msg.slice(0, 200));
      return { status: 'error' };
    }

    const raw = await res.text();
    console.error('QR poll raw response:', raw.slice(0, 300));
    let data: ILQrcodeStatusResponse;
    try {
      data = JSON.parse(raw) as ILQrcodeStatusResponse;
    } catch {
      console.error('QR poll: JSON parse failed');
      return { status: 'error' };
    }

    switch (data.status) {
      case 'wait':
        return { status: 'waiting' };
      case 'scaned':
        return { status: 'scanned' };
      case 'confirmed': {
        if (!data.bot_token) {
          return { status: 'error' };
        }
        return {
          status: 'confirmed',
          botToken: data.bot_token,
          botId: data.ilink_bot_id,
          userId: data.ilink_user_id,
          baseUrl: data.baseurl,
        };
      }
      case 'expired':
        return { status: 'expired' };
      default:
        return { status: 'waiting' };
    }
  } catch (err: unknown) {
    console.error('QR poll exception:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal.aborted) {
        return { status: 'error' };
      }
      return { status: 'waiting' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Combine two AbortSignals into one — aborted when either is aborted.
 */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0];

  const controller = new AbortController();
  const abort = (): void => controller.abort();

  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      return controller.signal;
    }
    sig.addEventListener('abort', abort, { once: true });
  }

  // Clean up listeners after the combined signal fires
  controller.signal.addEventListener('abort', () => {
    for (const sig of signals) {
      sig.removeEventListener('abort', abort);
    }
  }, { once: true });

  return controller.signal;
}

/**
 * Generate a random X-WECHAT-UIN header value.
 *
 * Format: base64 of the decimal string representation of a random uint32.
 * This is sent with every authenticated iLink API call.
 */
export function randomWechatUin(): string {
  const buf = crypto.randomBytes(4);
  const uin = buf.readUInt32BE(0);
  return Buffer.from(String(uin)).toString('base64');
}
