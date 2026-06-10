/**
 * EvalRunner — computes retrieval quality metrics against annotated eval pairs.
 *
 * Usage: pnpm eval:memory
 *        pnpm eval:memory --compare  (compare two configs)
 *
 * Metrics: Precision@5, Recall@5, Recall@10, MRR, NDCG@5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvalPair } from './eval-builder.js';

const EVAL_FILE = 'data/eval/query-memory-pairs.json';

interface EvalMetrics {
  pAt5: number;
  rAt5: number;
  rAt10: number;
  mrr: number;
  ndcgAt5: number;
  totalQueries: number;
  queriesWithResults: number;
}

export interface V11EvalCase {
  id: string;
  category: string;
  query: string;
  retrievedIds: string[];
  expectedIds?: string[];
  forbiddenIds?: string[];
  parseSuccess?: boolean;
}

export interface V11EvalReport {
  totalCases: number;
  precisionAt1: number;
  precisionAt3: number;
  forbiddenLeakage: number;
  stalePreferenceRate: number;
  parseSuccessRate: number;
  failedCaseIds: string[];
}

function dcg(relevances: number[], k: number): number {
  let score = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    score += relevances[i] / Math.log2(i + 2);
  }
  return score;
}

function ndcg(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  const relevances = retrievedIds.map(id => relevantIds.has(id) ? 1 : 0);
  const ideal = [...relevances].sort((a, b) => b - a);
  const dcgVal = dcg(relevances, k);
  const idcgVal = dcg(ideal, k);
  return idcgVal === 0 ? 0 : dcgVal / idcgVal;
}

export function computeMetrics(
  pairs: EvalPair[],
  retrieve: (query: string) => string[],
): EvalMetrics {
  let totalPAt5 = 0;
  let totalRAt5 = 0;
  let totalRAt10 = 0;
  let totalMrr = 0;
  let totalNdcg5 = 0;
  let queriesWithResults = 0;

  for (const pair of pairs) {
    if (!pair.relevantMemoryIds || pair.relevantMemoryIds.length === 0) continue;

    const retrieved = retrieve(pair.query);
    const relevantSet = new Set(pair.relevantMemoryIds);

    if (retrieved.length === 0) continue;
    queriesWithResults++;

    // P@5
    const pAt5 = retrieved.slice(0, 5).filter(id => relevantSet.has(id)).length / 5;
    totalPAt5 += pAt5;

    // R@5
    const rAt5 = retrieved.slice(0, 5).filter(id => relevantSet.has(id)).length / relevantSet.size;
    totalRAt5 += rAt5;

    // R@10
    const rAt10 = retrieved.slice(0, 10).filter(id => relevantSet.has(id)).length / relevantSet.size;
    totalRAt10 += rAt10;

    // MRR
    let mrr = 0;
    for (let i = 0; i < retrieved.length; i++) {
      if (relevantSet.has(retrieved[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }
    totalMrr += mrr;

    // NDCG@5
    totalNdcg5 += ndcg(retrieved, relevantSet, 5);
  }

  const n = pairs.filter(p => p.relevantMemoryIds && p.relevantMemoryIds.length > 0).length;
  return {
    pAt5: n > 0 ? totalPAt5 / n : 0,
    rAt5: n > 0 ? totalRAt5 / n : 0,
    rAt10: n > 0 ? totalRAt10 / n : 0,
    mrr: n > 0 ? totalMrr / n : 0,
    ndcgAt5: n > 0 ? totalNdcg5 / n : 0,
    totalQueries: n,
    queriesWithResults,
  };
}

export function formatMetricsReport(metrics: EvalMetrics, label?: string): string {
  const header = label ? `=== ${label} ===` : '=== Retrieval Evaluation ===';
  return [
    header,
    `Queries evaluated: ${metrics.queriesWithResults}/${metrics.totalQueries}`,
    `Precision@5:    ${(metrics.pAt5 * 100).toFixed(1)}%`,
    `Recall@5:       ${(metrics.rAt5 * 100).toFixed(1)}%`,
    `Recall@10:      ${(metrics.rAt10 * 100).toFixed(1)}%`,
    `MRR:            ${metrics.mrr.toFixed(4)}`,
    `NDCG@5:         ${metrics.ndcgAt5.toFixed(4)}`,
  ].join('\n');
}

export function computeV11EvalReport(cases: V11EvalCase[]): V11EvalReport {
  let precisionAt1Hits = 0;
  let precisionAt3Hits = 0;
  let precisionCases = 0;
  let forbiddenCases = 0;
  let forbiddenLeaks = 0;
  let staleCases = 0;
  let staleLeaks = 0;
  let parseCases = 0;
  let parseSuccesses = 0;
  const failedCaseIds: string[] = [];

  for (const evalCase of cases) {
    const expected = evalCase.expectedIds ?? [];
    const forbidden = evalCase.forbiddenIds ?? [];
    const expectedSet = new Set(expected);
    const forbiddenSet = new Set(forbidden);
    let failed = false;

    if (expected.length > 0) {
      precisionCases++;
      const top1Hit = evalCase.retrievedIds.slice(0, 1).some(id => expectedSet.has(id));
      const top3Hit = evalCase.retrievedIds.slice(0, 3).some(id => expectedSet.has(id));
      if (top1Hit) precisionAt1Hits++;
      if (top3Hit) precisionAt3Hits++;
      failed ||= !top3Hit;
    }

    if (forbidden.length > 0) {
      forbiddenCases++;
      const leaked = evalCase.retrievedIds.some(id => forbiddenSet.has(id));
      if (leaked) forbiddenLeaks++;
      failed ||= leaked;
      if (evalCase.category === 'stale_summary' || evalCase.category === 'preference_freshness') {
        staleCases++;
        if (leaked) staleLeaks++;
      }
    }

    if (evalCase.parseSuccess !== undefined) {
      parseCases++;
      if (evalCase.parseSuccess) parseSuccesses++;
      failed ||= !evalCase.parseSuccess;
    }

    if (failed) failedCaseIds.push(evalCase.id);
  }

  return {
    totalCases: cases.length,
    precisionAt1: precisionCases > 0 ? precisionAt1Hits / precisionCases : 1,
    precisionAt3: precisionCases > 0 ? precisionAt3Hits / precisionCases : 1,
    forbiddenLeakage: forbiddenCases > 0 ? forbiddenLeaks / forbiddenCases : 0,
    stalePreferenceRate: staleCases > 0 ? staleLeaks / staleCases : 0,
    parseSuccessRate: parseCases > 0 ? parseSuccesses / parseCases : 1,
    failedCaseIds,
  };
}

function main() {
  const evalPath = path.resolve(EVAL_FILE);

  if (!fs.existsSync(evalPath)) {
    console.log(`Eval file not found: ${evalPath}`);
    console.log('Run pnpm eval:memory:build to generate eval pairs, then annotate relevantMemoryIds.');
    console.log('');
    console.log(formatMetricsReport({
      pAt5: 0,
      rAt5: 0,
      rAt10: 0,
      mrr: 0,
      ndcgAt5: 0,
      totalQueries: 0,
      queriesWithResults: 0,
    }, 'Retrieval Evaluation (no dataset)'));
    return;
  }

  const pairs: EvalPair[] = JSON.parse(fs.readFileSync(evalPath, 'utf-8'));
  const annotated = pairs.filter(p => p.relevantMemoryIds && p.relevantMemoryIds.length > 0);

  if (annotated.length === 0) {
    console.log('No annotated eval pairs found. Add relevantMemoryIds to each pair in the JSON file.');
    console.log(`File: ${evalPath}`);
    console.log('');
    console.log(formatMetricsReport({
      pAt5: 0,
      rAt5: 0,
      rAt10: 0,
      mrr: 0,
      ndcgAt5: 0,
      totalQueries: 0,
      queriesWithResults: 0,
    }, 'Retrieval Evaluation (no annotations)'));
    return;
  }

  console.log(`Loaded ${annotated.length} annotated eval pairs (${pairs.length - annotated.length} unannotated skipped).`);
  console.log('');
  console.log('To compute metrics, integrate with a live MemoryRetriever instance.');
  console.log('This runner provides the metric computation functions — wire them into the app bootstrap for real numbers.');
  console.log('');
  console.log('Example integration:');
  console.log('  import { computeMetrics, formatMetricsReport } from "./eval-runner.js";');
  console.log('  const retrieve = (q: string) => memoryRetriever.retrieve({ query: q, topK: 10 }).then(r => r.map(m => m.id));');
  console.log('  const metrics = computeMetrics(pairs, retrieve);');
  console.log('  console.log(formatMetricsReport(metrics));');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
