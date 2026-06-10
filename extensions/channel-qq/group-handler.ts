// ---------------------------------------------------------------------------
// Group message handling utilities for the QQ channel (Bot API v2).
//
// Determines whether an incoming message should trigger the bot by:
// - Checking if the event is a group @-mention message
// - Checking if the sender's group is in the allowed groups whitelist
// ---------------------------------------------------------------------------

import type { QQMessageEvent, QQWsPayload } from './qq-types.js';
import { isGroupMessageEvent } from './qq-types.js';

/**
 * Check if the event is a GROUP_AT_MESSAGE_CREATE.
 */
export function isGroupMessage(event: QQWsPayload): boolean {
  return isGroupMessageEvent(event);
}

/**
 * Check if the event's group is in the allowed groups list.
 *
 * QQ Bot API v2 uses `group_openid` as the group identifier.
 * Returns true if `allowedGroups` is empty (allow all).
 */
export function isAllowedGroup(event: QQMessageEvent, allowedGroups: string[]): boolean {
  if (allowedGroups.length === 0) return true;
  if (!isGroupMessageEvent(event)) return false;

  const groupOpenid = event.d.group_openid ?? event.d.group_id;
  if (!groupOpenid) return false;

  return allowedGroups.includes(groupOpenid);
}
