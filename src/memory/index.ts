export { shouldCapture, detectCategory, isSafe } from './memory-filter.js';
export type { FilterResult, MemoryCategory } from './memory-filter.js';

export { applySchema } from './schema.js';
export { openDatabase, getDatabase, closeDatabase, resetDatabase } from './db.js';
export { loadSqliteVec, probeSqliteVec, sqliteVecAvailable, sqliteVecTableReady, vecInsert, vecSearch, vecDelete } from './sqlite-vec.js';

export { MemoryWriter } from './memory-writer.js';
export type { WriteOptions, WriteResult, SimilarMemoryMatch } from './memory-writer.js';

export { MemoryRetriever } from './memory-retriever.js';
export type { RetrievalOptions, RetrievedMemory } from './memory-retriever.js';
export { textFallbackRetrieve } from './fallback-retriever.js';

export { MemorySummarizer } from './memory-summarizer.js';
export type { SummarizeOptions } from './memory-summarizer.js';

export { expandQuery, escapeFtsQuery, needsQuoting } from './query-expansion.js';
export type { ExpandedQuery } from './query-expansion.js';

export {
  createEmptyPersona,
  personaJsonSchema,
  partialPersonaJsonSchema,
  personaSchemaForPrompt,
  partialPersonaSchemaForPrompt,
  personaToJson,
  personaFromJson,
} from './persona-model.js';
export type {
  UserPersona,
  PersonaRecord,
  PartialPersona,
} from './persona-model.js';

export { PersonaDistiller, createDistillerLLM } from './persona-distiller.js';
export type { DistillerLLM, PersonaStore, PreferenceQuery } from './persona-distiller.js';
