import type Database from 'better-sqlite3';

export interface MemoryTermInput {
  memoryId: string;
  term: string;
  termType: string;
  weight?: number;
}

export interface MemoryTermMatch {
  memory_id: string;
  score: number;
}

export class MemoryTermRepository {
  constructor(private db: Database.Database) {}

  replaceForMemory(memoryId: string, terms: Omit<MemoryTermInput, 'memoryId'>[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(memoryId);
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memory_terms (memory_id, term, term_type, weight)
        VALUES (@memoryId, @term, @termType, @weight)
      `);
      for (const term of terms) {
        stmt.run({
          memoryId,
          term: normalizeTerm(term.term),
          termType: term.termType,
          weight: term.weight ?? 1,
        });
      }
    });
    tx();
  }

  search(terms: string[], limit: number): MemoryTermMatch[] {
    const normalized = [...new Set(terms.map(normalizeTerm).filter(Boolean))];
    if (normalized.length === 0) return [];
    const placeholders = normalized.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT mt.memory_id, SUM(mt.weight) AS score
      FROM memory_terms mt
      JOIN memories m ON m.id = mt.memory_id
      WHERE mt.term IN (${placeholders})
        AND m.status = 'active'
      GROUP BY mt.memory_id
      ORDER BY score DESC
      LIMIT ?
    `).all(...normalized, limit) as MemoryTermMatch[];
  }
}

export function extractMemoryTerms(content: string, metadata?: Record<string, unknown> | null): Omit<MemoryTermInput, 'memoryId'>[] {
  const terms: Omit<MemoryTermInput, 'memoryId'>[] = [];
  const text = `${content} ${metadata ? JSON.stringify(metadata) : ''}`;
  for (const token of tokenize(text)) {
    terms.push({ term: token, termType: 'token', weight: token.length >= 6 ? 1.2 : 1 });
  }
  for (const number of text.match(/\b\d+(?:\.\d+)?\b/g) ?? []) {
    terms.push({ term: number, termType: 'number', weight: 1.6 });
  }
  const lower = text.toLowerCase();
  for (const month of MONTHS) {
    if (lower.includes(month)) terms.push({ term: month, termType: 'date', weight: 1.4 });
  }
  for (const weekday of WEEKDAYS) {
    if (lower.includes(weekday)) terms.push({ term: weekday, termType: 'date', weight: 1.3 });
  }
  if (metadata) {
    for (const key of ['speaker', 'sessionId', 'turnId', 'evidenceId', 'sampleId', 'corpusId']) {
      const value = metadata[key];
      if (typeof value === 'string') terms.push({ term: value, termType: key, weight: 1.5 });
    }
  }
  const seen = new Set<string>();
  return terms.filter(term => {
    const key = `${term.termType}:${normalizeTerm(term.term)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
}

export function extractQueryTerms(query: string): string[] {
  return [
    ...tokenize(query),
    ...(query.match(/\b\d+(?:\.\d+)?\b/g) ?? []),
    ...MONTHS.filter(month => query.toLowerCase().includes(month)),
    ...WEEKDAYS.filter(day => query.toLowerCase().includes(day)),
  ];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token));
}

function normalizeTerm(term: string): string {
  return term.toLowerCase().trim();
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'was', 'were', 'are',
  'what', 'when', 'where', 'who', 'how', 'did', 'does', 'have', 'has', 'had', 'from',
  'about', 'into', 'can', 'could', 'would', 'should', 'there', 'their', 'they', 'them',
  'then', 'than', 'but', 'not', 'all', 'any', 'our', 'out', 'get', 'got', 'left',
]);

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
];

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
