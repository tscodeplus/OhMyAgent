// ---------------------------------------------------------------------------
// Shared module-level store instances for cross-tool state sharing
// ---------------------------------------------------------------------------

import { InMemoryTeamRunStore } from '../../../orchestrator/team-run-store.js';

export const sharedTeamRunStore = new InMemoryTeamRunStore();
