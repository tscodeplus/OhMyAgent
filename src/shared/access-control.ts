// ---------------------------------------------------------------------------
// Channel access control — the sender whitelist every channel enforces
// ---------------------------------------------------------------------------
//
// Five copies existed (feishu / telegram / wechat / qq handlers plus the
// cross-channel admin check), each re-deriving the same rule with slightly
// different guards. The rule is small and worth stating once: a whitelist is
// either absent (the gateway is open to every sender) or exhaustive (only the
// listed ids may interact). Anything else — a list containing an empty string,
// an unknown sender — must not fall through to "allowed".

/**
 * True when `senderId` may interact under `allowedUsers`.
 * An empty or undefined list allows everyone; a populated list allows only the
 * named sender, and an unknown sender never matches it.
 */
export function isSenderAllowed(
  allowedUsers: readonly string[] | undefined,
  senderId: string | undefined,
): boolean {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  return !!senderId && allowedUsers.includes(senderId);
}

/** True when a whitelist is configured, i.e. the gateway is not open. */
export function hasSenderWhitelist(allowedUsers: readonly string[] | undefined): boolean {
  return !!allowedUsers && allowedUsers.length > 0;
}
