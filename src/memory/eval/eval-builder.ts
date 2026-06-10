/**
 * EvalSet Builder — constructs query → expected-memory pairs from real sessions.
 *
 * Usage: npx tsx src/memory/eval/eval-builder.ts
 * Output: data/eval/query-memory-pairs.json
 *
 * Process:
 *   1. Sample user queries from the messages table
 *   2. Run current retrieval system to get topK results for each query
 *   3. Output JSON for manual or LLM-assisted relevance annotation
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EvalPair {
  query: string;
  candidateMemoryIds: string[];
  /** Manually annotated: which candidate IDs are relevant. */
  relevantMemoryIds?: string[];
  /** Minimum expected recall (0-1). Default 1.0 means all relevant should be found. */
  minExpectedRecall?: number;
}

const OUTPUT_DIR = 'data/eval';
const OUTPUT_FILE = 'query-memory-pairs.json';

function main() {
  const dbPath = process.env.DATABASE_PATH || '~/.ohmyagent/data/app.db';
  const resolved = dbPath.replace(/^~/, process.env.HOME || '/home/iwapu');

  if (!fs.existsSync(resolved)) {
    console.error(`Database not found: ${resolved}`);
    process.exit(1);
  }

  const db = new Database(resolved, { readonly: true });

  // Sample up to 100 user messages from the last 30 days
  const rows = db.prepare(`
    SELECT DISTINCT m.content, m.session_id
    FROM messages m
    WHERE m.role = 'user'
      AND m.created_at > datetime('now', '-30 days')
      AND length(m.content) >= 10
    ORDER BY random()
    LIMIT 100
  `).all() as { content: string; session_id: string }[];

  if (rows.length === 0) {
    console.error('No user messages found in the last 30 days.');
    db.close();
    process.exit(1);
  }

  // Build eval pairs without running retrieval (that requires full bootstrap)
  // Instead, output candidate queries for annotation
  const pairs: EvalPair[] = rows.map(r => ({
    query: r.content.trim().slice(0, 200),
    candidateMemoryIds: [],
  }));

  // Deduplicate by query similarity (simple: same first 20 chars)
  const seen = new Set<string>();
  const deduped = pairs.filter(p => {
    const key = p.query.slice(0, 20);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ensure output directory
  fs.mkdirSync(path.resolve(OUTPUT_DIR), { recursive: true });

  const outputPath = path.resolve(OUTPUT_DIR, OUTPUT_FILE);
  fs.writeFileSync(outputPath, JSON.stringify(deduped, null, 2), 'utf-8');

  console.log(`Generated ${deduped.length} eval pairs → ${outputPath}`);
  console.log('Next: annotate relevantMemoryIds for each query, then run eval-runner.ts');

  db.close();
}

main();
