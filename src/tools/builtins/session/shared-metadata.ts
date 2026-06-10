// ---------------------------------------------------------------------------
// Shared module-level session metadata store
// Used by plan mode and worktree tools for cross-tool state sharing.
// ---------------------------------------------------------------------------

export const sessionMetadata = new Map<string, Record<string, unknown>>();
