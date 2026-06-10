import { describe, it, expect } from 'vitest';
import { computeV11EvalReport } from '../../src/memory/eval/eval-runner.js';

describe('computeV11EvalReport', () => {
  it('computes v11 quality metrics and failed case ids', () => {
    const report = computeV11EvalReport([
      {
        id: 'recall-ok',
        category: 'recall_semantic',
        query: 'dark mode',
        retrievedIds: ['mem-a', 'mem-b'],
        expectedIds: ['mem-a'],
      },
      {
        id: 'leak',
        category: 'agent_isolation',
        query: 'private',
        retrievedIds: ['forbidden'],
        forbiddenIds: ['forbidden'],
      },
      {
        id: 'parse-fail',
        category: 'summary_parse',
        query: '',
        retrievedIds: [],
        parseSuccess: false,
      },
    ]);

    expect(report.totalCases).toBe(3);
    expect(report.precisionAt1).toBe(1);
    expect(report.precisionAt3).toBe(1);
    expect(report.forbiddenLeakage).toBe(1);
    expect(report.parseSuccessRate).toBe(0);
    expect(report.failedCaseIds).toEqual(['leak', 'parse-fail']);
  });
});
