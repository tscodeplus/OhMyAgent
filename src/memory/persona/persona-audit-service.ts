import type { MemoryRepository } from '../repositories/memory-repository.js';
import type { PersonaStore } from '../persona-store.js';
import type { PersonaDistillationLog } from './persona-distillation-log.js';
import { detectTopic } from '../write/preference-conflict-resolver.js';

export interface ActivePreference {
  id: string;
  topic: string;
  content: string;
  updatedAt: string;
  sourceChannel: string | null;
}

export interface SupersededPreference {
  id: string;
  supersededBy: string | null;
  content: string;
}

export interface DerivedField {
  field: string;
  value: string;
  evidenceIds: string[];
  confidence: number;
}

export interface PersonaAudit {
  personaUpdatedAt: string | null;
  hasPersona: boolean;
  activePreferences: ActivePreference[];
  supersededPreferences: SupersededPreference[];
  derivedFields: DerivedField[];
  lastDistillation: {
    mode: string | null;
    status: string | null;
    timestamp: string | null;
    error: string | null;
  };
}

export class PersonaAuditService {
  constructor(
    private memoryRepo: MemoryRepository,
    private personaStore: PersonaStore | undefined,
    private distillationLog: PersonaDistillationLog | undefined,
  ) {}

  audit(): PersonaAudit {
    const persona = this.personaStore?.get() ?? null;

    // Active preferences (findByScopeKind already filters status='active')
    const activePrefs = this.memoryRepo.findByScopeKind('user', 'preference');
    const activePreferences: ActivePreference[] = activePrefs.map(p => ({
      id: p.id,
      topic: detectTopic(p.content),
      content: p.content,
      updatedAt: p.updated_at,
      sourceChannel: p.source_channel,
    }));

    // Superseded preferences
    const allPrefs = this.memoryRepo.findByScopeKind('user', 'preference', { includeInactive: true })
      .filter(p => p.status === 'superseded');
    const supersededPreferences: SupersededPreference[] = allPrefs.map(p => ({
      id: p.id,
      supersededBy: null,
      content: p.content,
    }));

    // Find superseding memory for each superseded preference
    for (const sp of supersededPreferences) {
      const superseding = this.memoryRepo.findSuperseding(sp.id);
      if (superseding) {
        sp.supersededBy = superseding.id;
      }
    }

    // Derived fields from persona
    const derivedFields: DerivedField[] = [];
    if (persona) {
      const preferredNameMatch = persona.preferences.communication.match(/称呼用户为([^；;]+)/);
      if (preferredNameMatch) {
        const name = preferredNameMatch[1].trim();
        const evidenceIds = activePrefs
          .filter(p => detectTopic(p.content) === 'preferred_name')
          .map(p => p.id);
        derivedFields.push({
          field: 'preferred_name',
          value: name,
          evidenceIds,
          confidence: evidenceIds.length > 0 ? 1.0 : 0.5,
        });
      }
    }

    // Last distillation
    const lastRun = this.distillationLog?.getLastRun();
    const lastDistillation = {
      mode: lastRun?.mode ?? null,
      status: lastRun?.status ?? null,
      timestamp: lastRun?.started_at ?? null,
      error: lastRun?.error ?? null,
    };

    return {
      personaUpdatedAt: persona?.lastUpdated ?? null,
      hasPersona: persona !== null,
      activePreferences,
      supersededPreferences,
      derivedFields,
      lastDistillation,
    };
  }
}
