/**
 * Shared iLink API call helper.
 *
 * Wraps fetch with authentication headers, JSON body serialization,
 * timeout, and response error checking.
 *
 * Every POST request automatically includes:
 * - iLink-specific headers (App-Id, ClientVersion, X-WECHAT-UIN)
 * - Content-Length for protocol compliance
 * - base_info.channel_version and base_info.bot_agent in the body
 */

import { randomWechatUin } from './wechat-auth.js';
import type { ILApiResponse } from './wechat-types.js';
import https from 'node:https';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const ILINK_APP_ID = 'ohmyagent';
const CHANNEL_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------

/**
 * Convert a semver string ("1.0.0") to a uint32 for ClientVersion.
 * Bits 24-16 major, 15-8 minor, 7-0 patch.
 */
function buildClientVersion(version: string): number {
  const parts = version.split('.').map(Number);
  return ((parts[0] ?? 0) << 16) | ((parts[1] ?? 0) << 8) | (parts[2] ?? 0);
}

/** Headers shared by all iLink requests (auth-agnostic). */
function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(CHANNEL_VERSION)),
  };
}

/**
 * Build full authentication headers for an iLink API call.
 */
function buildHeaders(token: string, bodyLen: number): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(bodyLen),
    'X-WECHAT-UIN': randomWechatUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...buildCommonHeaders(),
  };
}

/** base_info payload included in every iLink POST body. */
function buildBaseInfo(): Record<string, string> {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: 'OhMyAgent/1.0',
  };
}

/**
 * Make an authenticated POST request to the iLink API.
 *
 * @param apiBase    iLink API base URL (e.g. https://ilinkai.weixin.qq.com).
 * @param botToken   Bot authentication token.
 * @param endpoint   API path (e.g. "ilink/bot/sendmessage").
 * @param body       JSON-serializable request body (base_info injected automatically).
 * @param timeoutMs  Fetch timeout in milliseconds (default 10s).
 * @returns          Parsed JSON response (ret must be 0; otherwise throws).
 * @throws           On HTTP error, non-zero ret, or timeout.
 */
export async function apiPost(
  apiBase: string,
  botToken: string,
  endpoint: string,
  body: unknown,
  timeoutMs = 10_000,
): Promise<ILApiResponse> {
  const url = new URL(`${apiBase}/${endpoint}`);

  // Merge base_info into every request body
  const mergedBody = { ...(body as Record<string, unknown>), base_info: buildBaseInfo() };
  const bodyStr = JSON.stringify(mergedBody);

  // Use native https module instead of fetch to avoid undici connection pool
  // contention with the getupdates long-poll (they share a pool and sendmessage starves).
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: buildHeaders(botToken, Buffer.byteLength(bodyStr, 'utf-8')),
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => data += chunk.toString());
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `iLink API HTTP ${response.status}: ${response.text.slice(0, 200)} for ${endpoint}`,
    );
  }

  let json: ILApiResponse;
  try {
    json = JSON.parse(response.text) as ILApiResponse;
  } catch {
    throw new Error(
      `iLink API JSON parse failed for ${endpoint}: ${response.text.slice(0, 200)}`,
    );
  }

  if (json.ret !== undefined && json.ret !== 0) {
    const err = new Error(
      `iLink API error: ret=${json.ret} errcode=${json.errcode ?? ''} errmsg=${json.errmsg ?? ''} for ${endpoint}`,
    );
    (err as { errcode?: string }).errcode = json.errcode;
    (err as { ret?: number }).ret = json.ret;
    throw err;
  }

  return json;
}

/**
 * Send typing indicator to a WeChat user via iLink API.
 *
 * @param apiBase    iLink API base URL.
 * @param token      Bot authentication token.
 * @param body       ilink_user_id, typing_ticket, and status (1=TYPING, 2=CANCEL).
 * @param timeoutMs  Fetch timeout in milliseconds (default 10s).
 */
export async function sendTyping(
  apiBase: string,
  token: string,
  body: {
    ilink_user_id: string;
    typing_ticket: string;
    status: number;
  },
  timeoutMs?: number,
): Promise<void> {
  await apiPost(apiBase, token, 'ilink/bot/sendtyping', body, timeoutMs);
}

/**
 * Fetch bot config (includes typing_ticket) for a given user.
 *
 * @param apiBase    iLink API base URL.
 * @param token      Bot authentication token.
 * @param body       ilink_user_id and context_token.
 * @param timeoutMs  Fetch timeout in milliseconds (default 10s).
 * @returns          Config object including optional typing_ticket.
 */
export async function getConfig(
  apiBase: string,
  token: string,
  body: {
    ilink_user_id: string;
    context_token: string;
  },
  timeoutMs?: number,
): Promise<{ typing_ticket?: string; [key: string]: unknown }> {
  const resp = await apiPost(apiBase, token, 'ilink/bot/getconfig', body, timeoutMs);
  return resp as { typing_ticket?: string; [key: string]: unknown };
}

/**
 * Notify iLink that bot is starting.
 *
 * @param apiBase  iLink API base URL.
 * @param token    Bot authentication token.
 */
export async function notifyStart(apiBase: string, token: string): Promise<void> {
  await apiPost(apiBase, token, 'ilink/bot/msg/notifystart', {});
}

/**
 * Notify iLink that bot is stopping.
 *
 * @param apiBase  iLink API base URL.
 * @param token    Bot authentication token.
 */
export async function notifyStop(apiBase: string, token: string): Promise<void> {
  await apiPost(apiBase, token, 'ilink/bot/msg/notifystop', {});
}
